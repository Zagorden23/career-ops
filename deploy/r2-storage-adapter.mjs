/**
 * deploy/r2-storage-adapter.mjs
 * Production-grade Persistent Storage Adapter for Cloudflare R2 on Render Free.
 *
 * Implements:
 * 1. Startup Hydration: Downloads persistent state from R2 into local ephemeral working directory.
 * 2. Real-time Write-Through: Immediately pushes local file writes to R2.
 * 3. File Watcher & Sync: Debounced background watcher for asynchronous core script writes.
 * 4. Safe Concurrency & Conditional Writes: Uses ETags/If-Match where supported.
 * 5. Flush on Shutdown: Ensures pending mutations are cleanly uploaded before SIGTERM exit.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { R2Client } from "./r2-client.mjs";
import { listTree } from "../lib/walk-tree.mjs";

const EXCLUDE_SYNC_PATTERNS = [
  /\.tmp$/,
  /\.tmp\./,
  /\.bak$/,
  /\.bak\./,
  /\.lock$/,
  /\.DS_Store/,
  /desktop\.ini/,
  /Thumbs\.db/,
  /node_modules/,
  /\.next/,
  /\.git/,
];

export class R2StorageAdapter {
  /**
   * @param {object} options
   * @param {R2Client} options.client - Configured R2Client instance
   * @param {string} options.localDataRoot - Local working data root directory
   */
  constructor({ client, localDataRoot }) {
    if (!client) throw new Error("R2Client is required for R2StorageAdapter");
    if (!localDataRoot) throw new Error("localDataRoot is required for R2StorageAdapter");

    this.client = client;
    this.localDataRoot = path.resolve(localDataRoot);
    this.watcher = null;
    this.pendingSyncs = new Map();
    this.syncDebounceTimer = null;
    this.isFlushing = false;
  }

  /**
   * Ensure local directory structure exists.
   */
  ensureLocalDirs() {
    const dirs = ["data", "config", "modes", "reports", "output", ".sessions"];
    for (const d of dirs) {
      const p = path.join(this.localDataRoot, d);
      if (!fs.existsSync(p)) {
        fs.mkdirSync(p, { recursive: true, mode: 0o750 });
      }
    }
  }

  /**
   * Normalize and validate relative path / object key.
   * @param {string} relPath
   * @returns {string} Normalized key
   */
  normalizeKey(relPath) {
    const clean = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
    const parts = clean.split("/").filter(Boolean);
    if (parts.some((p) => p === ".." || p === ".")) {
      throw new Error(`Invalid path traversal attempt: ${relPath}`);
    }
    return parts.join("/");
  }

  /**
   * Guess content-type based on file extension.
   */
  guessContentType(filename) {
    const ext = path.extname(filename).toLowerCase();
    switch (ext) {
      case ".md":
      case ".markdown":
        return "text/markdown; charset=utf-8";
      case ".json":
        return "application/json; charset=utf-8";
      case ".yml":
      case ".yaml":
        return "application/yaml; charset=utf-8";
      case ".tsv":
        return "text/tab-separated-values; charset=utf-8";
      case ".txt":
        return "text/plain; charset=utf-8";
      case ".html":
        return "text/html; charset=utf-8";
      case ".pdf":
        return "application/pdf";
      case ".svg":
        return "image/svg+xml";
      case ".png":
        return "image/png";
      default:
        return "application/octet-stream";
    }
  }

  /**
   * Hydrate local ephemeral filesystem from R2 bucket.
   * Downloads all objects from the bucket into localDataRoot.
   * @returns {Promise<{ downloaded: number, skipped: number, errors: string[] }>}
   */
  async hydrateFromR2() {
    this.ensureLocalDirs();
    console.log(`[r2-storage] Starting hydration from R2 bucket '${this.client.bucketName}' into '${this.localDataRoot}'...`);

    let downloaded = 0;
    let skipped = 0;
    const errors = [];

    try {
      // Every page: one listing call stops at 1000 objects, and a bucket that
      // holds more would come back with part of the data missing.
      const keys = await this.client.listAllObjects();
      console.log(`[r2-storage] Found ${keys.length} objects in R2 bucket.`);

      for (const item of keys) {
        try {
          // normalizeKey() refuses "..": an object key must not be able to
          // name a path outside the data root.
          const key = this.normalizeKey(item.key);
          if (!key) continue;
          const localPath = path.join(this.localDataRoot, key);

          // Check if local file already matches size and timestamp
          if (fs.existsSync(localPath)) {
            const stat = fs.statSync(localPath);
            if (stat.size === item.size) {
              skipped++;
              continue;
            }
          }

          // Ensure parent directory
          fs.mkdirSync(path.dirname(localPath), { recursive: true });

          // Download object
          const res = await this.client.getObject(key);
          if (res.ok && res.data) {
            fs.writeFileSync(localPath, res.data);
            downloaded++;
          }
        } catch (err) {
          errors.push(`Failed to download ${item.key}: ${err.message}`);
        }
      }

      console.log(`[r2-storage] Hydration completed. Downloaded: ${downloaded}, Skipped (up-to-date): ${skipped}, Errors: ${errors.length}`);
      return { downloaded, skipped, errors };
    } catch (err) {
      console.error(`[r2-storage] Hydration error: ${err.message}`);
      throw err;
    }
  }

  /**
   * Write a file directly to local storage AND Cloudflare R2 (write-through).
   * @param {string} relPath
   * @param {Buffer|string} content
   * @param {object} [options]
   * @param {string} [options.ifMatch]
   * @returns {Promise<{ ok: true, etag: string }>}
   */
  async writeFile(relPath, content, { ifMatch } = {}) {
    const key = this.normalizeKey(relPath);
    const localPath = path.join(this.localDataRoot, key);

    // 1. Write locally (atomic temp file rename)
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    const tempFile = `${localPath}.tmp.${process.pid}.${Date.now()}`;
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    fs.writeFileSync(tempFile, buffer);
    fs.renameSync(tempFile, localPath);

    // 2. Upload to R2
    const contentType = this.guessContentType(key);
    const result = await this.client.putObject(key, buffer, { contentType, ifMatch });
    return result;
  }

  /**
   * Delete a file locally AND from Cloudflare R2.
   * @param {string} relPath
   * @returns {Promise<{ ok: true }>}
   */
  async deleteFile(relPath) {
    const key = this.normalizeKey(relPath);
    const localPath = path.join(this.localDataRoot, key);

    if (fs.existsSync(localPath)) {
      try {
        fs.unlinkSync(localPath);
      } catch (err) {
        console.warn(`[r2-storage] Could not delete local file ${localPath}: ${err.message}`);
      }
    }

    return this.client.deleteObject(key);
  }

  /**
   * Start debounced background filesystem watcher on localDataRoot.
   * Automatically uploads changes to R2.
   */
  startBackgroundSync() {
    if (this.watcher) return;
    this.ensureLocalDirs();

    console.log(`[r2-storage] Starting background filesystem watcher on ${this.localDataRoot}...`);

    try {
      this.watcher = fs.watch(this.localDataRoot, { recursive: true }, (eventType, filename) => {
        if (!filename) return;

        // Check excluded patterns
        if (EXCLUDE_SYNC_PATTERNS.some((pat) => pat.test(filename))) {
          return;
        }

        const localPath = path.join(this.localDataRoot, filename);
        if (!fs.existsSync(localPath)) {
          // File was deleted
          this.pendingSyncs.set(filename, { type: "delete" });
        } else {
          try {
            const stat = fs.statSync(localPath);
            if (stat.isFile()) {
              this.pendingSyncs.set(filename, { type: "put", mtime: stat.mtimeMs });
            }
          } catch {
            // file disappeared or temporary race
          }
        }

        this.scheduleSync();
      });
    } catch (err) {
      console.warn(`[r2-storage] Warning: could not start recursive fs watcher: ${err.message}`);
    }
  }

  /**
   * Delete every object under a directory prefix from the bucket (the local
   * files are the caller's to remove). Used when a workspace is deleted.
   * @param {string} relDir Directory relative to the data root
   * @returns {Promise<number>} Objects deleted
   */
  async deletePrefix(relDir) {
    const prefix = this.normalizeKey(relDir);
    // An empty prefix would match the whole bucket.
    if (!prefix) throw new Error("deletePrefix requires a non-empty directory");
    const objects = await this.client.listAllObjects({ prefix: `${prefix}/` });
    let deleted = 0;
    for (const item of objects) {
      // The watcher may already have queued these; drop them so a late "put"
      // cannot re-create an object this call just removed.
      this.pendingSyncs.delete(item.key);
      this.pendingSyncs.delete(item.key.replace(/\//g, path.sep));
      await this.client.deleteObject(item.key);
      deleted++;
    }
    return deleted;
  }

  scheduleSync() {
    if (this.syncDebounceTimer) clearTimeout(this.syncDebounceTimer);
    this.syncDebounceTimer = setTimeout(() => {
      this.processPendingSyncs().catch((err) => {
        console.error(`[r2-storage] Background sync error: ${err.message}`);
      });
    }, 400);
    if (this.syncDebounceTimer.unref) this.syncDebounceTimer.unref();
  }

  /**
   * @param {object} [options]
   * @param {boolean} [options.duringFlush] Set by flush() itself. Background
   *   ticks stand down while a flush runs; the flush must still drain the
   *   queue, or the deletes waiting in it are lost and the deleted files come
   *   back at the next hydration.
   */
  async processPendingSyncs({ duringFlush = false } = {}) {
    if (this.pendingSyncs.size === 0 || (this.isFlushing && !duringFlush)) return;

    const entries = Array.from(this.pendingSyncs.entries());
    this.pendingSyncs.clear();

    for (const [filename, item] of entries) {
      try {
        const key = this.normalizeKey(filename);
        if (item.type === "delete") {
          await this.client.deleteObject(key);
          console.log(`[r2-storage] Synced delete to R2: ${key}`);
        } else if (item.type === "put") {
          const localPath = path.join(this.localDataRoot, filename);
          if (fs.existsSync(localPath)) {
            const content = fs.readFileSync(localPath);
            const contentType = this.guessContentType(filename);
            await this.client.putObject(key, content, { contentType });
            console.log(`[r2-storage] Synced update to R2: ${key} (${content.length} bytes)`);
          }
        }
      } catch (err) {
        console.error(`[r2-storage] Failed to sync ${filename} to R2: ${err.message}`);
      }
    }
  }

  /**
   * Flush all pending mutations and synchronize any modified local files to R2.
   */
  async flush() {
    this.isFlushing = true;
    console.log("[r2-storage] Flushing storage sync to Cloudflare R2...");

    if (this.watcher) {
      try {
        this.watcher.close();
      } catch {}
      this.watcher = null;
    }

    if (this.syncDebounceTimer) {
      clearTimeout(this.syncDebounceTimer);
      this.syncDebounceTimer = null;
    }

    // Process any remaining items
    await this.processPendingSyncs({ duringFlush: true });

    // Full scan of user dirs to ensure nothing was missed
    const files = [];
    if (fs.existsSync(this.localDataRoot)) {
      for (const abs of listTree(this.localDataRoot)) {
        const rel = path.relative(this.localDataRoot, abs).replace(/\\/g, "/");
        if (!EXCLUDE_SYNC_PATTERNS.some((pat) => pat.test(rel))) {
          files.push(rel);
        }
      }
    }
    let flushedCount = 0;

    for (const rel of files) {
      try {
        const key = this.normalizeKey(rel);
        const localPath = path.join(this.localDataRoot, rel);
        const content = fs.readFileSync(localPath);
        const contentType = this.guessContentType(rel);
        await this.client.putObject(key, content, { contentType });
        flushedCount++;
      } catch (err) {
        console.error(`[r2-storage] Error flushing ${rel}: ${err.message}`);
      }
    }

    console.log(`[r2-storage] Flush complete. Synced ${flushedCount} objects to R2.`);
    this.isFlushing = false;
  }
}

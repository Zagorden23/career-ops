#!/usr/bin/env node
/**
 * deploy/r2-migrate.mjs
 * Data Migration Utility for Career Ops -> Cloudflare R2.
 *
 * Scans personal career data from the source directory, computes SHA-256 checksums,
 * uploads objects to the private R2 bucket, and generates a verifiable migration manifest.
 *
 * Excludes: node_modules, build artifacts, git metadata, temp files, and credentials.
 * Does NOT delete or mutate any local files.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { listTree } from "../lib/walk-tree.mjs";
import { isMainModule } from "../lib/is-main-module.mjs";
import { fileURLToPath } from "node:url";
import { R2Client } from "./r2-client.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const codeRoot = path.resolve(__dirname, "..");

// Folders and files that belong to the User Layer
const USER_PATHS_TO_MIGRATE = [
  "cv.md",
  "article-digest.md",
  "portals.yml",
  path.join("config", "profile.yml"),
  path.join("config", "cv-facts.json"),
  path.join("modes", "_profile.md"),
  path.join("modes", "_custom.md"),
  "data",
  "reports",
  "output",
  "interview-prep",
  "documents",
  "jds",
  ".sessions",
];

const EXCLUDE_FILE_PATTERNS = [
  /\.tmp$/,
  /\.tmp\./,
  /\.bak$/,
  /\.bak\./,
  /\.lock$/,
  /\.gitkeep$/,
  /\.DS_Store/,
  /Thumbs\.db/,
  /\.git/,
  /node_modules/,
];

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function collectFiles(sourceDir) {
  const fileList = [];

  for (const rel of USER_PATHS_TO_MIGRATE) {
    const full = path.join(sourceDir, rel);
    if (!fs.existsSync(full)) continue;

    const stat = fs.statSync(full);
    if (stat.isFile()) {
      if (!EXCLUDE_FILE_PATTERNS.some((p) => p.test(rel))) {
        fileList.push(rel.replace(/\\/g, "/"));
      }
    } else if (stat.isDirectory()) {
      const allFiles = listTree(full);
      for (const abs of allFiles) {
        const itemRel = path.relative(sourceDir, abs).replace(/\\/g, "/");
        if (!EXCLUDE_FILE_PATTERNS.some((p) => p.test(itemRel))) {
          fileList.push(itemRel);
        }
      }
    }
  }

  return fileList;
}

/**
 * Execute data migration to Cloudflare R2.
 * @param {object} options
 * @param {R2Client} options.client
 * @param {string} options.sourceDir
 * @returns {Promise<{ ok: boolean, manifest: object }>}
 */
export async function migrateDataToR2({ client, sourceDir }) {
  console.log("==================================================");
  console.log("Career Ops Data Migration to Cloudflare R2");
  console.log(`Source: ${sourceDir}`);
  console.log(`Bucket: ${client.bucketName}`);
  console.log("==================================================");

  const files = collectFiles(sourceDir);
  console.log(`Discovered ${files.length} user files eligible for migration.`);

  const manifest = {
    version: "1.0",
    migratedAt: new Date().toISOString(),
    bucket: client.bucketName,
    totalFiles: files.length,
    totalBytes: 0,
    files: [],
  };

  let uploadedCount = 0;
  let verifiedCount = 0;

  for (const relKey of files) {
    const localPath = path.join(sourceDir, relKey);
    const content = fs.readFileSync(localPath);
    const hash = sha256(content);
    manifest.totalBytes += content.length;

    console.log(`Uploading [${uploadedCount + 1}/${files.length}]: ${relKey} (${content.length} bytes)...`);
    const { etag } = await client.putObject(relKey, content);
    uploadedCount++;

    // Verify immediately
    const head = await client.headObject(relKey);
    if (!head.exists || head.size !== content.length) {
      throw new Error(`Verification mismatch for ${relKey}: uploaded size ${content.length} vs R2 size ${head.size}`);
    }
    verifiedCount++;

    manifest.files.push({
      key: relKey,
      size: content.length,
      sha256: hash,
      etag: etag || head.etag,
      verified: true,
    });
  }

  // Upload migration manifest to R2
  const manifestJson = JSON.stringify(manifest, null, 2);
  await client.putObject("migration-manifest.json", manifestJson, {
    contentType: "application/json; charset=utf-8",
  });

  console.log("==================================================");
  console.log(`Migration Complete: ${uploadedCount} files uploaded, ${verifiedCount} verified.`);
  console.log(`Total Data: ${(manifest.totalBytes / 1024).toFixed(2)} KB.`);
  console.log("Manifest stored at R2: migration-manifest.json");
  console.log("==================================================");

  return { ok: true, manifest };
}

// CLI handler
async function runCli() {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucketName = process.env.R2_BUCKET_NAME || "career-ops-data";
  const endpoint = process.env.R2_ENDPOINT;
  const sourceDir = process.env.CAREER_OPS_ROOT || codeRoot;

  if (!accessKeyId || !secretAccessKey) {
    console.error("Error: R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY environment variables are required.");
    process.exit(1);
  }

  const client = new R2Client({ accountId, accessKeyId, secretAccessKey, bucketName, endpoint });
  await migrateDataToR2({ client, sourceDir });
}

if (isMainModule(import.meta.url)) {
  runCli().catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
  });
}

/**
 * deploy/workspace-manager.mjs
 * One private workspace per account.
 *
 * The web app reads a single data root per process (CAREER_OPS_ROOT), and so do
 * the core scripts it spawns. Serving two accounts from one process would show
 * each the other's CV and tracker. So every signed-in account gets its own data
 * directory and its own app process pointed at it, started the first time that
 * account makes a request and stopped after it has been idle.
 *
 *   owner (the env-configured login)  ->  <data root>            (existing data, unchanged)
 *   any other account                 ->  <data root>/.tenants/<account id>
 *
 * Processes cost memory, so the number alive at once is capped. When the cap is
 * reached the least recently used idle one is stopped to make room; if every
 * one is mid-request the newcomer is told to retry rather than evicting someone
 * else's work.
 *
 * This manager owns bookkeeping only. How a process is started is injected
 * (`startWorker`), which keeps it testable without Next.js.
 */

import fs from "node:fs";
import path from "node:path";
import { USER_ID_RE } from "./user-store.mjs";

export const OWNER_ACCOUNT_ID = "owner";
export const TENANTS_DIRNAME = ".tenants";

/** Directories a fresh workspace starts with (the user layer of the data contract). */
export const WORKSPACE_SEED_DIRS = ["data", "config", "modes", "reports", "output"];

export class WorkspaceManager {
  /**
   * @param {object} options
   * @param {string} options.ownerRoot Data root of the owner account
   * @param {string} [options.tenantsDir] Parent of all other workspaces
   * @param {(input: { key: string, root: string }) => Promise<{ host?: string, port: number, stop: () => Promise<void> | void, exited?: Promise<unknown> }>} options.startWorker
   * @param {number} [options.maxWorkers] Processes alive at once (default 3)
   * @param {number} [options.idleMs] Stop a process idle this long (default 15 minutes)
   * @param {(root: string, account: object) => Promise<void> | void} [options.onWorkspaceRemoved]
   * @param {() => number} [options.now]
   */
  constructor({
    ownerRoot,
    tenantsDir,
    startWorker,
    maxWorkers = 3,
    idleMs = 15 * 60 * 1000,
    onWorkspaceRemoved = null,
    now = Date.now,
  }) {
    if (!ownerRoot) throw new Error("ownerRoot is required for WorkspaceManager");
    if (typeof startWorker !== "function") throw new Error("startWorker is required for WorkspaceManager");
    this.ownerRoot = path.resolve(ownerRoot);
    this.tenantsDir = path.resolve(tenantsDir || path.join(this.ownerRoot, TENANTS_DIRNAME));
    this.startWorker = startWorker;
    this.maxWorkers = Math.max(1, maxWorkers);
    this.idleMs = idleMs;
    this.onWorkspaceRemoved = onWorkspaceRemoved;
    this.now = now;
    /** @type {Map<string, { key: string, root: string, active: number, lastUsed: number, ready: Promise<object>, handle: object | null }>} */
    this.workers = new Map();
    this.closed = false;

    this.reaper = setInterval(() => {
      this.reapIdle().catch((err) => console.error(`[workspaces] Idle sweep failed: ${err.message}`));
    }, Math.min(60_000, Math.max(1_000, Math.floor(this.idleMs / 2))));
    if (this.reaper.unref) this.reaper.unref();
  }

  /**
   * The data directory for an account. The id is checked against the exact
   * shape the account store generates, so it can never name a path outside
   * the tenants directory.
   * @param {{ id: string }} account
   */
  rootFor(account) {
    if (!account || typeof account.id !== "string") throw new Error("An account is required");
    if (account.id === OWNER_ACCOUNT_ID) return this.ownerRoot;
    if (!USER_ID_RE.test(account.id)) throw new Error("Account id is not a valid workspace name");
    return path.join(this.tenantsDir, account.id);
  }

  ensureWorkspace(account) {
    const root = this.rootFor(account);
    for (const dir of WORKSPACE_SEED_DIRS) {
      fs.mkdirSync(path.join(root, dir), { recursive: true, mode: 0o750 });
    }
    return root;
  }

  /**
   * Get the running process for an account, starting it if needed. The caller
   * must call `release()` when its request has finished.
   * @param {{ id: string }} account
   * @returns {Promise<{ host: string, port: number, release: () => void }>}
   */
  async acquire(account) {
    if (this.closed) throw busy("The server is shutting down.");
    const key = account.id;
    let entry = this.workers.get(key);

    if (!entry) {
      if (this.workers.size >= this.maxWorkers && !(await this.evictOne())) {
        throw busy("All workspaces are busy right now. Please try again in a moment.");
      }
      // evictOne() awaited: another request for this account may have started it meanwhile.
      entry = this.workers.get(key) || this.start(key, account);
    }

    entry.active += 1;
    entry.lastUsed = this.now();
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      entry.active = Math.max(0, entry.active - 1);
      entry.lastUsed = this.now();
    };

    try {
      const handle = await entry.ready;
      return { host: handle.host || "127.0.0.1", port: handle.port, release };
    } catch (err) {
      release();
      throw err;
    }
  }

  start(key, account) {
    const root = this.ensureWorkspace(account);
    const entry = { key, root, active: 0, lastUsed: this.now(), ready: null, handle: null };
    entry.ready = Promise.resolve()
      .then(() => this.startWorker({ key, root }))
      .then((handle) => {
        entry.handle = handle;
        // A process that dies on its own is forgotten, so the next request starts a new one.
        if (handle.exited && typeof handle.exited.then === "function") {
          handle.exited
            .catch(() => {})
            .then(() => {
              if (this.workers.get(key) === entry) this.workers.delete(key);
            });
        }
        return handle;
      })
      .catch((err) => {
        if (this.workers.get(key) === entry) this.workers.delete(key);
        throw err;
      });
    // The rejection is delivered to whoever awaits `ready`; this stops Node
    // reporting it as unhandled when the only waiter has already gone away.
    entry.ready.catch(() => {});
    this.workers.set(key, entry);
    return entry;
  }

  async stopEntry(entry) {
    if (this.workers.get(entry.key) === entry) this.workers.delete(entry.key);
    try {
      const handle = await entry.ready;
      await handle.stop();
    } catch {
      // never started, or already gone
    }
  }

  /** Stop the least recently used process that has no request in flight. */
  async evictOne() {
    let candidate = null;
    for (const entry of this.workers.values()) {
      if (entry.active > 0) continue;
      if (!candidate || entry.lastUsed < candidate.lastUsed) candidate = entry;
    }
    if (!candidate) return false;
    await this.stopEntry(candidate);
    return true;
  }

  async reapIdle() {
    const now = this.now();
    const idle = [...this.workers.values()].filter((e) => e.active === 0 && now - e.lastUsed >= this.idleMs);
    await Promise.all(idle.map((e) => this.stopEntry(e)));
    return idle.length;
  }

  /**
   * Stop an account's process and delete its workspace. Never the owner's:
   * that directory is the deployment's own data root.
   * @param {{ id: string }} account
   */
  async removeWorkspace(account) {
    if (account.id === OWNER_ACCOUNT_ID) throw new Error("The owner workspace cannot be removed");
    const root = this.rootFor(account);
    const entry = this.workers.get(account.id);
    if (entry) await this.stopEntry(entry);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    if (this.onWorkspaceRemoved) await this.onWorkspaceRemoved(root, account);
  }

  stats() {
    return {
      running: this.workers.size,
      max: this.maxWorkers,
      active: [...this.workers.values()].reduce((sum, e) => sum + e.active, 0),
    };
  }

  async shutdown() {
    this.closed = true;
    clearInterval(this.reaper);
    await Promise.all([...this.workers.values()].map((e) => this.stopEntry(e)));
  }
}

function busy(message) {
  const err = new Error(message);
  err.code = "WORKSPACE_BUSY";
  return err;
}

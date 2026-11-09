/**
 * deploy/auth-store.mjs
 * Persistent, file-backed session store for Career Ops on Render.
 *
 * Sessions are stored as JSON in a dedicated directory on the persistent disk
 * (outside the personal documents directory), surviving service restarts.
 * Writes use atomic replace (write to temp file then rename) to prevent corruption.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Default timeouts: 7 days absolute, 24 hours idle
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export class AuthStore {
  /**
   * @param {object} options
   * @param {string} options.sessionDir - Directory to store sessions.json
   * @param {number} [options.maxAgeMs] - Absolute session max age
   * @param {number} [options.idleTimeoutMs] - Idle timeout
   */
  constructor({ sessionDir, maxAgeMs = DEFAULT_MAX_AGE_MS, idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS }) {
    if (!sessionDir) {
      throw new Error("sessionDir is required for AuthStore");
    }
    this.sessionDir = path.resolve(sessionDir);
    this.sessionFilePath = path.join(this.sessionDir, "sessions.json");
    this.maxAgeMs = maxAgeMs;
    this.idleTimeoutMs = idleTimeoutMs;
    /** @type {Map<string, { id: string, user: string, createdAt: number, lastActive: number, csrfToken: string }>} */
    this.sessions = new Map();
    this.ensureDirectory();
    this.load();
  }

  ensureDirectory() {
    try {
      if (!fs.existsSync(this.sessionDir)) {
        fs.mkdirSync(this.sessionDir, { recursive: true, mode: 0o700 });
      }
    } catch (err) {
      throw new Error(`Failed to create session directory ${this.sessionDir}: ${err.message}`);
    }
  }

  load() {
    this.sessions.clear();
    if (!fs.existsSync(this.sessionFilePath)) {
      return;
    }
    try {
      const raw = fs.readFileSync(this.sessionFilePath, "utf8");
      if (!raw.trim()) return;
      const data = JSON.parse(raw);
      if (Array.isArray(data)) {
        const now = Date.now();
        for (const s of data) {
          if (s && s.id && typeof s.id === "string") {
            const isAbsoluteExpired = now - s.createdAt > this.maxAgeMs;
            const isIdleExpired = now - s.lastActive > this.idleTimeoutMs;
            if (!isAbsoluteExpired && !isIdleExpired) {
              this.sessions.set(s.id, s);
            }
          }
        }
      }
    } catch (err) {
      console.warn(`[auth-store] Warning: failed to parse ${this.sessionFilePath}: ${err.message}`);
    }
  }

  persist() {
    try {
      this.ensureDirectory();
      const list = Array.from(this.sessions.values());
      const tempFile = path.join(
        this.sessionDir,
        `sessions.json.tmp.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString("hex")}`
      );
      fs.writeFileSync(tempFile, JSON.stringify(list, null, 2), { mode: 0o600 });
      fs.renameSync(tempFile, this.sessionFilePath);
    } catch (err) {
      console.error(`[auth-store] Error persisting sessions: ${err.message}`);
    }
  }

  /**
   * Create a new session for a user.
   * @param {string} user
   * @returns {{ id: string, user: string, createdAt: number, lastActive: number, csrfToken: string }}
   */
  createSession(user) {
    const id = crypto.randomBytes(32).toString("hex");
    const csrfToken = crypto.randomBytes(32).toString("hex");
    const now = Date.now();
    const session = {
      id,
      user,
      createdAt: now,
      lastActive: now,
      csrfToken,
    };
    this.sessions.set(id, session);
    this.persist();
    return session;
  }

  /**
   * Look up a session and verify it is not expired.
   * @param {string} sessionId
   * @returns {{ id: string, user: string, createdAt: number, lastActive: number, csrfToken: string } | null}
   */
  getSession(sessionId) {
    if (!sessionId || typeof sessionId !== "string") return null;
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    const now = Date.now();
    const isAbsoluteExpired = now - session.createdAt > this.maxAgeMs;
    const isIdleExpired = now - session.lastActive > this.idleTimeoutMs;

    if (isAbsoluteExpired || isIdleExpired) {
      this.sessions.delete(sessionId);
      this.persist();
      return null;
    }

    return session;
  }

  /**
   * Slide the idle activity timestamp of a session.
   * @param {string} sessionId
   */
  touchSession(sessionId) {
    const session = this.getSession(sessionId);
    if (session) {
      session.lastActive = Date.now();
      // Only persist every 60 seconds of activity to avoid excessive disk I/O
      if (!session._lastSaved || Date.now() - session._lastSaved > 60_000) {
        session._lastSaved = Date.now();
        this.persist();
      }
    }
  }

  /**
   * Destroy an active session (logout).
   * @param {string} sessionId
   * @returns {boolean}
   */
  destroySession(sessionId) {
    if (!sessionId) return false;
    const existed = this.sessions.delete(sessionId);
    if (existed) {
      this.persist();
    }
    return existed;
  }

  /**
   * Delete any expired sessions.
   * @returns {number} Count of pruned sessions
   */
  pruneExpired() {
    const now = Date.now();
    let count = 0;
    for (const [id, session] of this.sessions.entries()) {
      if (now - session.createdAt > this.maxAgeMs || now - session.lastActive > this.idleTimeoutMs) {
        this.sessions.delete(id);
        count++;
      }
    }
    if (count > 0) {
      this.persist();
    }
    return count;
  }

  /**
   * Validate a CSRF token for a given session.
   * @param {string} sessionId
   * @param {string} token
   * @returns {boolean}
   */
  validateCsrf(sessionId, token) {
    if (!token || typeof token !== "string") return false;
    const session = this.getSession(sessionId);
    if (!session || !session.csrfToken) return false;
    try {
      const a = Buffer.from(session.csrfToken, "utf8");
      const b = Buffer.from(token, "utf8");
      if (a.length !== b.length) return false;
      return crypto.timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }
}

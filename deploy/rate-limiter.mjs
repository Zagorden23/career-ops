/**
 * deploy/rate-limiter.mjs
 * Persistent sliding window rate limiter with exponential back-off and lockout
 * for login attempts in Career Ops.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export class LoginRateLimiter {
  /**
   * @param {object} [options]
   * @param {number} [options.maxAttempts] - Max attempts before temporary lockout (default: 5)
   * @param {number} [options.windowMs] - Time window for tracking attempts (default: 15 minutes)
   * @param {number} [options.lockoutMs] - Lockout duration after max attempts (default: 15 minutes)
   * @param {number} [options.globalMaxAttempts] - Max global failed attempts across all IPs (default: 50)
   * @param {string} [options.stateFilePath] - Optional path to persist rate limit state (survives restarts)
   * @param {number} [options.maxKeys] - Most keys tracked at once; the oldest are dropped past it (default: 10000)
   */
  constructor({
    maxAttempts = 5,
    windowMs = 15 * 60 * 1000,
    lockoutMs = 15 * 60 * 1000,
    globalMaxAttempts = 50,
    stateFilePath = null,
    maxKeys = 10_000,
  } = {}) {
    this.maxKeys = maxKeys;
    this.maxAttempts = maxAttempts;
    this.windowMs = windowMs;
    this.lockoutMs = lockoutMs;
    this.globalMaxAttempts = globalMaxAttempts;
    this.stateFilePath = stateFilePath ? path.resolve(stateFilePath) : null;

    /** @type {Map<string, { attempts: number[], lockedUntil: number }>} */
    this.ipMap = new Map();
    /** @type {number[]} */
    this.globalAttempts = [];

    if (this.stateFilePath) {
      this.load();
    }

    // Periodic cleanup every 10 minutes
    this.cleanupTimer = setInterval(() => this.cleanup(), 10 * 60 * 1000);
    if (this.cleanupTimer.unref) this.cleanupTimer.unref();
  }

  load() {
    if (!this.stateFilePath || !fs.existsSync(this.stateFilePath)) return;
    try {
      const raw = fs.readFileSync(this.stateFilePath, "utf8");
      if (!raw.trim()) return;
      const data = JSON.parse(raw);
      const now = Date.now();
      if (Array.isArray(data.globalAttempts)) {
        this.globalAttempts = data.globalAttempts.filter((t) => typeof t === "number" && now - t < this.windowMs);
      }
      if (data.ipMap && typeof data.ipMap === "object") {
        for (const [ip, entry] of Object.entries(data.ipMap)) {
          if (entry && (entry.lockedUntil > now || (Array.isArray(entry.attempts) && entry.attempts.some((t) => now - t < this.windowMs)))) {
            this.ipMap.set(ip, {
              attempts: (entry.attempts || []).filter((t) => now - t < this.windowMs),
              lockedUntil: entry.lockedUntil || 0,
            });
          }
        }
      }
    } catch (err) {
      console.warn(`[rate-limiter] Warning: could not parse state file: ${err.message}`);
    }
  }

  persist() {
    if (!this.stateFilePath) return;
    try {
      fs.mkdirSync(path.dirname(this.stateFilePath), { recursive: true, mode: 0o700 });
      const ipObj = {};
      for (const [ip, entry] of this.ipMap.entries()) {
        ipObj[ip] = entry;
      }
      const data = {
        globalAttempts: this.globalAttempts,
        ipMap: ipObj,
      };
      const tempPath = `${this.stateFilePath}.tmp.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString("hex")}`;
      fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), { mode: 0o600 });
      fs.renameSync(tempPath, this.stateFilePath);
    } catch (err) {
      console.error(`[rate-limiter] Error saving rate limit state: ${err.message}`);
    }
  }

  /**
   * Check if an IP is currently rate-limited or locked out.
   * @param {string} ip
   * @returns {{ allowed: boolean, retryAfterSeconds?: number, reason?: string }}
   */
  check(ip) {
    const now = Date.now();
    const entry = this.ipMap.get(ip);

    if (entry && entry.lockedUntil > now) {
      const retryAfterSeconds = Math.ceil((entry.lockedUntil - now) / 1000);
      return {
        allowed: false,
        retryAfterSeconds,
        reason: `Too many failed login attempts. Please wait ${retryAfterSeconds} seconds before trying again.`,
      };
    }

    // Check global failures
    this.globalAttempts = this.globalAttempts.filter((t) => now - t < this.windowMs);
    if (this.globalAttempts.length >= this.globalMaxAttempts) {
      return {
        allowed: false,
        retryAfterSeconds: 60,
        reason: "Login service temporarily rate limited due to high failure rate. Please try again later.",
      };
    }

    return { allowed: true };
  }

  /**
   * Calculate progressive delay in milliseconds based on consecutive failures.
   * Helps mitigate automated fast brute-force before lockout threshold is hit.
   * @param {string} ip
   * @returns {number} Delay in ms
   */
  getDelayMs(ip) {
    const entry = this.ipMap.get(ip);
    if (!entry) return 0;
    const count = entry.attempts.length;
    if (count <= 1) return 0;
    if (count === 2) return 500;
    if (count === 3) return 1000;
    if (count === 4) return 2000;
    return 3000;
  }

  /**
   * Record a failed login attempt.
   * @param {string} ip A client address, or any other key (e.g. `id:<account identifier>`)
   * @param {object} [options]
   * @param {boolean} [options.global=true] Count toward the global failure cap. One
   *   failed login recorded under two keys (client and account) passes false for
   *   the second so it is not counted twice.
   */
  recordFailure(ip, { global = true } = {}) {
    const now = Date.now();
    if (global) this.globalAttempts.push(now);

    let entry = this.ipMap.get(ip);
    if (!entry) {
      // Keys are attacker-chosen (any address, any identifier), so the table is
      // bounded: without this, a flood of distinct keys grows memory and the
      // state file without limit. A Map iterates oldest-first.
      while (this.ipMap.size >= this.maxKeys) {
        this.ipMap.delete(this.ipMap.keys().next().value);
      }
      entry = { attempts: [], lockedUntil: 0 };
      this.ipMap.set(ip, entry);
    }

    // Filter attempts inside the active window
    entry.attempts = entry.attempts.filter((t) => now - t < this.windowMs);
    entry.attempts.push(now);

    if (entry.attempts.length >= this.maxAttempts) {
      entry.lockedUntil = now + this.lockoutMs;
    }
    this.persist();
  }

  /**
   * Reset failed attempts upon successful login.
   * @param {string} ip
   */
  recordSuccess(ip) {
    if (this.ipMap.has(ip)) {
      this.ipMap.delete(ip);
      this.persist();
    }
  }

  cleanup() {
    const now = Date.now();
    let changed = false;
    for (const [ip, entry] of this.ipMap.entries()) {
      if (entry.lockedUntil <= now) {
        entry.attempts = entry.attempts.filter((t) => now - t < this.windowMs);
        if (entry.attempts.length === 0) {
          this.ipMap.delete(ip);
          changed = true;
        }
      }
    }
    const oldLen = this.globalAttempts.length;
    this.globalAttempts = this.globalAttempts.filter((t) => now - t < this.windowMs);
    if (changed || this.globalAttempts.length !== oldLen) {
      this.persist();
    }
  }

  destroy() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
  }
}

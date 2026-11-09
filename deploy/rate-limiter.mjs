/**
 * deploy/rate-limiter.mjs
 * In-memory sliding window rate limiter with exponential back-off and lockout
 * for login attempts in Career Ops.
 */

export class LoginRateLimiter {
  /**
   * @param {object} [options]
   * @param {number} [options.maxAttempts] - Max attempts before temporary lockout (default: 5)
   * @param {number} [options.windowMs] - Time window for tracking attempts (default: 15 minutes)
   * @param {number} [options.lockoutMs] - Lockout duration after max attempts (default: 15 minutes)
   * @param {number} [options.globalMaxAttempts] - Max global failed attempts across all IPs (default: 50)
   */
  constructor({
    maxAttempts = 5,
    windowMs = 15 * 60 * 1000,
    lockoutMs = 15 * 60 * 1000,
    globalMaxAttempts = 50,
  } = {}) {
    this.maxAttempts = maxAttempts;
    this.windowMs = windowMs;
    this.lockoutMs = lockoutMs;
    this.globalMaxAttempts = globalMaxAttempts;

    /** @type {Map<string, { attempts: number[], lockedUntil: number }>} */
    this.ipMap = new Map();
    /** @type {number[]} */
    this.globalAttempts = [];

    // Periodic cleanup every 10 minutes
    this.cleanupTimer = setInterval(() => this.cleanup(), 10 * 60 * 1000);
    if (this.cleanupTimer.unref) this.cleanupTimer.unref();
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
   * @param {string} ip
   */
  recordFailure(ip) {
    const now = Date.now();
    this.globalAttempts.push(now);

    let entry = this.ipMap.get(ip);
    if (!entry) {
      entry = { attempts: [], lockedUntil: 0 };
      this.ipMap.set(ip, entry);
    }

    // Filter attempts inside the active window
    entry.attempts = entry.attempts.filter((t) => now - t < this.windowMs);
    entry.attempts.push(now);

    if (entry.attempts.length >= this.maxAttempts) {
      entry.lockedUntil = now + this.lockoutMs;
    }
  }

  /**
   * Reset failed attempts upon successful login.
   * @param {string} ip
   */
  recordSuccess(ip) {
    this.ipMap.delete(ip);
  }

  cleanup() {
    const now = Date.now();
    for (const [ip, entry] of this.ipMap.entries()) {
      if (entry.lockedUntil <= now) {
        entry.attempts = entry.attempts.filter((t) => now - t < this.windowMs);
        if (entry.attempts.length === 0) {
          this.ipMap.delete(ip);
        }
      }
    }
    this.globalAttempts = this.globalAttempts.filter((t) => now - t < this.windowMs);
  }

  destroy() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
  }
}

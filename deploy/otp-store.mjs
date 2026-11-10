/**
 * deploy/otp-store.mjs
 * One-time verification codes for email and SMS sign-in, plus the small
 * sliding-window counter that caps how many codes can be requested.
 *
 * A challenge is created when a code is sent and names what the code proves
 * (which address, for which purpose). Only an HMAC of the code is kept, so a
 * memory dump or a log line never yields a usable code. A challenge allows a
 * handful of guesses and then burns itself: six digits are a million
 * possibilities, and the attempt cap is what makes that enough.
 *
 * Challenges live in memory on purpose. They last ten minutes; a restart costs
 * the user one "send a new code" click and saves writing codes-in-flight to disk.
 */

import crypto from "node:crypto";

const CODE_DIGITS = 6;

export class OtpStore {
  /**
   * @param {object} options
   * @param {string | Buffer} options.secret HMAC key for stored code digests
   * @param {number} [options.ttlMs] Lifetime of a challenge (default 10 minutes)
   * @param {number} [options.maxAttempts] Wrong guesses before the challenge burns (default 5)
   * @param {number} [options.resendCooldownMs] Minimum gap between sends (default 60 seconds)
   * @param {number} [options.maxSends] Sends per challenge, the first included (default 4)
   * @param {number} [options.maxChallenges] Memory bound (default 5000)
   * @param {() => number} [options.now]
   */
  constructor({
    secret,
    ttlMs = 10 * 60 * 1000,
    maxAttempts = 5,
    resendCooldownMs = 60 * 1000,
    maxSends = 4,
    maxChallenges = 5000,
    now = Date.now,
  } = {}) {
    if (!secret) throw new Error("secret is required for OtpStore");
    this.secret = secret;
    this.ttlMs = ttlMs;
    this.maxAttempts = maxAttempts;
    this.resendCooldownMs = resendCooldownMs;
    this.maxSends = maxSends;
    this.maxChallenges = maxChallenges;
    this.now = now;
    /** @type {Map<string, object>} */
    this.challenges = new Map();
  }

  digest(id, code) {
    return crypto.createHmac("sha256", this.secret).update(`${id}:${code}`).digest();
  }

  prune() {
    const now = this.now();
    for (const [id, c] of this.challenges) {
      if (c.expiresAt <= now) this.challenges.delete(id);
    }
    // Oldest first: a Map iterates in insertion order.
    while (this.challenges.size >= this.maxChallenges) {
      const oldest = this.challenges.keys().next().value;
      this.challenges.delete(oldest);
    }
  }

  /**
   * @param {object} input
   * @param {"email" | "phone"} input.channel
   * @param {string} input.destination Normalized email or E.164 phone
   * @param {string} input.purpose "login" | "signup" | "reset"
   * @param {object} [input.payload] Carried to the verifier (e.g. a pending password hash)
   * @param {boolean} [input.dead] A challenge no code can satisfy. It lets a
   *   request about an address that will never be sent a code look the same
   *   from outside as one that was.
   * @returns {{ id: string, code: string | null }}
   */
  create({ channel, destination, purpose, payload = {}, dead = false }) {
    this.prune();
    const id = crypto.randomBytes(24).toString("hex");
    const code = generateCode();
    const now = this.now();
    this.challenges.set(id, {
      id,
      channel,
      destination,
      purpose,
      payload,
      dead,
      digest: dead ? null : this.digest(id, code),
      attempts: 0,
      sends: 1,
      lastSentAt: now,
      expiresAt: now + this.ttlMs,
    });
    return { id, code: dead ? null : code };
  }

  /**
   * Read a live challenge without spending an attempt.
   * @param {string} id
   */
  get(id) {
    if (typeof id !== "string" || !id) return null;
    const c = this.challenges.get(id);
    if (!c) return null;
    if (c.expiresAt <= this.now()) {
      this.challenges.delete(id);
      return null;
    }
    return c;
  }

  /**
   * Check a code. A correct code consumes the challenge; so does the last
   * allowed wrong one.
   * @param {string} id
   * @param {unknown} code
   * @returns {{ ok: true, challenge: object } | { ok: false, reason: "expired" | "invalid" | "locked", remaining?: number }}
   */
  verify(id, code) {
    const c = this.get(id);
    if (!c) return { ok: false, reason: "expired" };

    const candidate = String(code ?? "").replace(/\s+/g, "");
    let matches = false;
    if (!c.dead && /^\d{6}$/.test(candidate)) {
      matches = crypto.timingSafeEqual(c.digest, this.digest(id, candidate));
    }

    if (matches) {
      this.challenges.delete(id);
      return { ok: true, challenge: c };
    }

    c.attempts += 1;
    if (c.attempts >= this.maxAttempts) {
      this.challenges.delete(id);
      return { ok: false, reason: "locked" };
    }
    return { ok: false, reason: "invalid", remaining: this.maxAttempts - c.attempts };
  }

  /**
   * Issue a fresh code on an existing challenge (the "send again" button). The
   * old code stops working and the guess counter starts over, but the send
   * count does not: it is the bound on how many messages one challenge costs.
   * @param {string} id
   * @returns {{ ok: true, code: string | null, challenge: object } | { ok: false, reason: "expired" | "cooldown" | "limit", retryAfterSeconds?: number }}
   */
  regenerate(id) {
    const c = this.get(id);
    if (!c) return { ok: false, reason: "expired" };
    const now = this.now();
    const wait = c.lastSentAt + this.resendCooldownMs - now;
    if (wait > 0) return { ok: false, reason: "cooldown", retryAfterSeconds: Math.ceil(wait / 1000) };
    if (c.sends >= this.maxSends) return { ok: false, reason: "limit" };

    const code = generateCode();
    c.sends += 1;
    c.lastSentAt = now;
    c.attempts = 0;
    c.expiresAt = now + this.ttlMs;
    if (!c.dead) c.digest = this.digest(id, code);
    return { ok: true, code: c.dead ? null : code, challenge: c };
  }

  discard(id) {
    this.challenges.delete(id);
  }
}

function generateCode() {
  return String(crypto.randomInt(0, 10 ** CODE_DIGITS)).padStart(CODE_DIGITS, "0");
}

/**
 * Counts events per key inside a sliding window. Used to cap code requests per
 * address, per client and in total, which is what keeps an SMS bill bounded.
 */
export class SlidingWindowCounter {
  /**
   * @param {object} [options]
   * @param {() => number} [options.now]
   * @param {number} [options.maxKeys]
   */
  constructor({ now = Date.now, maxKeys = 20000 } = {}) {
    this.now = now;
    this.maxKeys = maxKeys;
    /** @type {Map<string, number[]>} */
    this.events = new Map();
  }

  /**
   * How long until `key` may act again, without recording anything.
   * @returns {number} Seconds to wait; 0 when allowed now.
   */
  retryAfter(key, max, windowMs) {
    const now = this.now();
    const recent = (this.events.get(key) || []).filter((t) => now - t < windowMs);
    if (recent.length < max) return 0;
    return Math.max(1, Math.ceil((recent[0] + windowMs - now) / 1000));
  }

  /** Record one event for `key`. */
  record(key, windowMs) {
    const now = this.now();
    const recent = (this.events.get(key) || []).filter((t) => now - t < windowMs);
    recent.push(now);
    this.events.delete(key); // re-insert so the Map's order tracks recency
    this.events.set(key, recent);
    while (this.events.size > this.maxKeys) {
      this.events.delete(this.events.keys().next().value);
    }
  }
}

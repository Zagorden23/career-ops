/**
 * deploy/user-store.mjs
 * File-backed account store for the Career Ops gateway.
 *
 * One JSON file (users.json) next to sessions.json, written with the same
 * atomic temp-file + rename as the session store. It holds identifiers and a
 * scrypt password hash, never a plaintext secret and never an OTP code.
 *
 * An account is reachable through any identifier it has proved: an email, a
 * phone number, a Google subject id. Each of those is unique across accounts,
 * which is what lets "sign in with Google" land on the same account that first
 * signed up with the same verified email.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const USER_ID_RE = /^u_[a-f0-9]{16}$/;
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:".]{2,}$/;
const E164_RE = /^\+[1-9]\d{7,14}$/;

/**
 * Trim and lowercase an email. Returns null when it is not a deliverable-looking
 * address, so callers never store or send to free text.
 * @param {unknown} raw
 * @returns {string | null}
 */
export function normalizeEmail(raw) {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  if (!email || email.length > 254) return null;
  if (!EMAIL_RE.test(email)) return null;
  return email;
}

/**
 * Normalize a phone number to E.164 ("+919876543210").
 *
 * A number typed without a country code is only accepted when the deployment
 * names a default one; guessing a country would send codes to strangers.
 * @param {unknown} raw
 * @param {string} [defaultCountryCode] e.g. "+91"
 * @returns {string | null}
 */
export function normalizePhone(raw, defaultCountryCode = "") {
  if (typeof raw !== "string") return null;
  let value = raw.trim();
  if (!value || value.length > 32) return null;
  if (/[^\d+\s().-]/.test(value)) return null;
  const hasPlus = value.startsWith("+");
  let digits = value.replace(/\D/g, "");
  if (!digits) return null;

  if (!hasPlus && digits.startsWith("00")) {
    value = `+${digits.slice(2)}`;
  } else if (hasPlus) {
    value = `+${digits}`;
  } else {
    const cc = String(defaultCountryCode || "").replace(/\D/g, "");
    if (!cc) return null;
    // A national number is commonly written with a leading trunk zero.
    digits = digits.replace(/^0+/, "");
    value = `+${cc}${digits}`;
  }
  return E164_RE.test(value) ? value : null;
}

/**
 * @param {unknown} password
 * @returns {string | null} A user-facing problem, or null when acceptable.
 */
export function validatePassword(password) {
  if (typeof password !== "string") return "Enter a password.";
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return `Password must be at most ${PASSWORD_MAX_LENGTH} characters.`;
  }
  if (!password.trim()) return "Password cannot be only spaces.";
  return null;
}

/** "ja***@example.com" — enough to recognise, not enough to harvest. */
export function maskEmail(email) {
  const [local, domain] = String(email).split("@");
  if (!domain) return "***";
  const shown = local.length <= 2 ? local.slice(0, 1) : local.slice(0, 2);
  return `${shown}***@${domain}`;
}

/** "+91******3210" */
export function maskPhone(phone) {
  const value = String(phone);
  if (value.length <= 6) return "***";
  return `${value.slice(0, 3)}${"*".repeat(Math.max(3, value.length - 7))}${value.slice(-4)}`;
}

const FIELDS = [
  "id",
  "email",
  "emailVerified",
  "phone",
  "phoneVerified",
  "passwordHash",
  "googleSub",
  "name",
  "createdAt",
  "lastLoginAt",
];

export class UserStore {
  /**
   * @param {object} options
   * @param {string} options.dir Directory that holds users.json
   */
  constructor({ dir }) {
    if (!dir) throw new Error("dir is required for UserStore");
    this.dir = path.resolve(dir);
    this.filePath = path.join(this.dir, "users.json");
    /** @type {Map<string, object>} */
    this.users = new Map();
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.load();
  }

  load() {
    this.users.clear();
    let raw;
    try {
      raw = fs.readFileSync(this.filePath, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") return; // no accounts yet
      throw new Error(`Cannot read ${this.filePath}: ${err.message}`);
    }
    if (!raw.trim()) return;
    let data;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      // A corrupt account file must not read as "no accounts": the next sign-up
      // would then overwrite every existing account with a one-user file.
      throw new Error(`Account file ${this.filePath} is not valid JSON: ${err.message}`);
    }
    if (!Array.isArray(data)) {
      throw new Error(`Account file ${this.filePath} must hold a JSON array`);
    }
    for (const u of data) {
      if (u && typeof u.id === "string" && USER_ID_RE.test(u.id)) this.users.set(u.id, u);
    }
  }

  persist() {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const temp = path.join(
      this.dir,
      `users.json.tmp.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString("hex")}`,
    );
    fs.writeFileSync(temp, JSON.stringify(Array.from(this.users.values()), null, 2), { mode: 0o600 });
    fs.renameSync(temp, this.filePath);
  }

  count() {
    return this.users.size;
  }

  findById(id) {
    return (typeof id === "string" && this.users.get(id)) || null;
  }

  findByEmail(email) {
    if (!email) return null;
    for (const u of this.users.values()) if (u.email === email) return u;
    return null;
  }

  findByPhone(phone) {
    if (!phone) return null;
    for (const u of this.users.values()) if (u.phone === phone) return u;
    return null;
  }

  findByGoogleSub(sub) {
    if (!sub) return null;
    for (const u of this.users.values()) if (u.googleSub === sub) return u;
    return null;
  }

  assertUnique(candidate, exceptId = null) {
    for (const u of this.users.values()) {
      if (u.id === exceptId) continue;
      if (candidate.email && u.email === candidate.email) throw duplicate("email");
      if (candidate.phone && u.phone === candidate.phone) throw duplicate("phone");
      if (candidate.googleSub && u.googleSub === candidate.googleSub) throw duplicate("googleSub");
    }
  }

  /**
   * @param {object} fields
   * @returns {object} The stored user
   */
  create(fields = {}) {
    const user = {
      id: `u_${crypto.randomBytes(8).toString("hex")}`,
      email: fields.email || null,
      emailVerified: Boolean(fields.email && fields.emailVerified),
      phone: fields.phone || null,
      phoneVerified: Boolean(fields.phone && fields.phoneVerified),
      passwordHash: fields.passwordHash || null,
      googleSub: fields.googleSub || null,
      name: cleanName(fields.name),
      createdAt: Date.now(),
      lastLoginAt: null,
    };
    if (!user.email && !user.phone && !user.googleSub) {
      throw new Error("An account needs an email, a phone number or a Google identity");
    }
    this.assertUnique(user);
    this.users.set(user.id, user);
    this.persist();
    return user;
  }

  /**
   * @param {string} id
   * @param {object} patch Only known account fields are applied.
   * @returns {object | null}
   */
  update(id, patch = {}) {
    const user = this.findById(id);
    if (!user) return null;
    const next = { ...user };
    for (const key of FIELDS) {
      if (key === "id" || key === "createdAt") continue;
      if (Object.prototype.hasOwnProperty.call(patch, key)) next[key] = patch[key];
    }
    if (Object.prototype.hasOwnProperty.call(patch, "name")) next.name = cleanName(patch.name);
    this.assertUnique(next, id);
    this.users.set(id, next);
    this.persist();
    return next;
  }

  delete(id) {
    const existed = this.users.delete(id);
    if (existed) this.persist();
    return existed;
  }
}

function duplicate(field) {
  const err = new Error(`An account with this ${field} already exists`);
  err.code = "DUPLICATE_IDENTIFIER";
  err.field = field;
  return err;
}

function cleanName(name) {
  if (typeof name !== "string") return null;
  // Control characters out: the name is echoed into pages and mail headers.
  const value = name.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  return value || null;
}

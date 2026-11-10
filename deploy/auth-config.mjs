/**
 * deploy/auth-config.mjs
 * Reads the account and workspace settings from the environment.
 *
 * Kept apart from the supervisor so the rules can be tested without starting a
 * server. A setting that is present but wrong throws: a misspelt sign-up mode
 * that silently fell back to "open" would publish a deployment its operator
 * meant to keep closed.
 */

import crypto from "node:crypto";
import { normalizeEmail } from "./user-store.mjs";

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {{
 *   ownerEmail: string | null,
 *   signup: { mode: "open" | "closed", allowlist: string[] },
 *   defaultCountryCode: string,
 *   smsHourlyCap: number,
 *   publicUrl: string | null,
 *   secret: string | Buffer,
 *   google: { clientId: string, clientSecret: string } | null,
 *   maxWorkspaces: number,
 *   workspaceIdleMs: number,
 *   shareAiKeys: boolean,
 *   warnings: string[],
 * }}
 */
export function loadAuthConfig(env) {
  const warnings = [];

  const mode = (env.CAREER_OPS_SIGNUP?.trim().toLowerCase() || "open");
  if (mode !== "open" && mode !== "closed") {
    throw new Error('CAREER_OPS_SIGNUP must be "open" or "closed"');
  }

  const allowlist = (env.CAREER_OPS_SIGNUP_ALLOWLIST || "")
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  for (const entry of allowlist) {
    const isDomain = /^@?[a-z0-9.-]+\.[a-z]{2,}$/.test(entry);
    if (!isDomain && !normalizeEmail(entry)) {
      throw new Error(`CAREER_OPS_SIGNUP_ALLOWLIST entry "${entry}" is neither an email address nor a domain`);
    }
  }

  let ownerEmail = null;
  if (env.CAREER_OPS_OWNER_EMAIL?.trim()) {
    ownerEmail = normalizeEmail(env.CAREER_OPS_OWNER_EMAIL);
    if (!ownerEmail) throw new Error("CAREER_OPS_OWNER_EMAIL is not a valid email address");
  }

  let defaultCountryCode = "";
  if (env.CAREER_OPS_AUTH_DEFAULT_COUNTRY_CODE?.trim()) {
    const raw = env.CAREER_OPS_AUTH_DEFAULT_COUNTRY_CODE.trim();
    if (!/^\+?[1-9]\d{0,3}$/.test(raw)) {
      throw new Error('CAREER_OPS_AUTH_DEFAULT_COUNTRY_CODE must look like "+91"');
    }
    defaultCountryCode = raw.startsWith("+") ? raw : `+${raw}`;
  }

  let publicUrl = null;
  if (env.CAREER_OPS_PUBLIC_URL?.trim()) {
    let parsed;
    try {
      parsed = new URL(env.CAREER_OPS_PUBLIC_URL.trim());
    } catch {
      throw new Error("CAREER_OPS_PUBLIC_URL is not a valid URL");
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("CAREER_OPS_PUBLIC_URL must start with https:// or http://");
    }
    publicUrl = parsed.origin;
  }

  const googleId = env.GOOGLE_CLIENT_ID?.trim();
  const googleSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  if (Boolean(googleId) !== Boolean(googleSecret)) {
    throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set together");
  }

  // Signs form tokens and code digests. Both are short-lived, so a secret that
  // changes on restart costs at most a re-submitted form.
  let secret = env.CAREER_OPS_SESSION_SECRET?.trim();
  if (!secret || secret.length < 16) {
    if (secret) warnings.push("CAREER_OPS_SESSION_SECRET is shorter than 16 characters; using a random one for this run.");
    secret = crypto.randomBytes(32);
  }

  if (env.CAREER_OPS_AUTH_DEV_OTP === "1" && env.NODE_ENV === "production") {
    warnings.push("CAREER_OPS_AUTH_DEV_OTP is ignored in production: codes are never written to the log there.");
  }

  return {
    ownerEmail,
    signup: { mode, allowlist },
    defaultCountryCode,
    smsHourlyCap: positiveInt(env.CAREER_OPS_AUTH_SMS_HOURLY_CAP, 60, "CAREER_OPS_AUTH_SMS_HOURLY_CAP"),
    publicUrl,
    secret,
    google: googleId ? { clientId: googleId, clientSecret: googleSecret } : null,
    maxWorkspaces: positiveInt(env.CAREER_OPS_MAX_WORKSPACES, 3, "CAREER_OPS_MAX_WORKSPACES"),
    workspaceIdleMs:
      positiveInt(env.CAREER_OPS_WORKSPACE_IDLE_MINUTES, 15, "CAREER_OPS_WORKSPACE_IDLE_MINUTES") * 60 * 1000,
    shareAiKeys: env.CAREER_OPS_SHARE_AI_KEYS === "1",
    warnings,
  };
}

function positiveInt(raw, fallback, name) {
  if (raw === undefined || String(raw).trim() === "") return fallback;
  const value = Number(String(raw).trim());
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a whole number of 1 or more`);
  return value;
}

/**
 * Variables no app process needs: the gateway's own credentials. An app
 * process runs agent CLIs and user-triggered scripts, so anything in its
 * environment is one prompt away from being printed.
 */
const GATEWAY_ONLY = [
  /^R2_/,
  /^CAREER_OPS_AUTH_/,
  /^CAREER_OPS_SESSION_/,
  /^CAREER_OPS_OWNER_EMAIL$/,
  /^CAREER_OPS_SIGNUP/,
  /^GOOGLE_CLIENT_/,
  /^RESEND_/,
  /^SMTP_/,
  /^TWILIO_/,
];

/**
 * Overrides that name ONE file or directory for the whole deployment. Passed
 * to every account's process they would point all of them at the same tracker
 * or profile, so only the owner's process keeps them.
 */
const OWNER_ONLY_PATHS = [
  "CAREER_OPS_DATA_DIR",
  "CAREER_OPS_TRACKER",
  "CAREER_OPS_PROFILE",
  "CAREER_OPS_PORTALS",
  "CAREER_OPS_SCHEDULED_JOBS_PATH",
];

/**
 * The environment for one account's app process.
 * @param {NodeJS.ProcessEnv} env The supervisor's environment
 * @param {object} options
 * @param {boolean} options.isOwner
 * @param {boolean} options.shareAiKeys Give non-owner accounts the deployment's AI provider keys
 * @param {Record<string, string>} options.overrides Values this process must have (root, port, ...)
 * @returns {Record<string, string>}
 */
export function buildWorkerEnv(env, { isOwner, shareAiKeys, overrides }) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (GATEWAY_ONLY.some((pattern) => pattern.test(key))) continue;
    if (!isOwner) {
      if (OWNER_ONLY_PATHS.includes(key)) continue;
      // The owner's provider keys are the owner's bill.
      if (!shareAiKeys && /_API_KEY$/.test(key)) continue;
    }
    out[key] = value;
  }
  return { ...out, ...overrides };
}

/**
 * deploy/notifiers.mjs
 * Delivery of sign-in codes by email and SMS.
 *
 * Each channel is optional and is switched on by its credentials being present
 * in the environment. A channel with no sender is simply not offered on the
 * sign-in page, so a deployment that configures nothing keeps working with
 * passwords and (if configured) Google.
 *
 *   Email   RESEND_API_KEY                        -> Resend HTTP API
 *           SMTP_HOST (+ SMTP_USER / SMTP_PASS)   -> any SMTP relay, e.g. Gmail
 *   SMS     TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN
 *           + TWILIO_FROM_NUMBER or TWILIO_MESSAGING_SERVICE_SID
 *
 * CAREER_OPS_AUTH_DEV_OTP=1 prints codes to the server log instead of sending
 * them. It is refused in production: a code in a log is a code anyone with log
 * access can use.
 */

import { sendSmtpMail, extractAddress } from "./smtp-client.mjs";

const HTTP_TIMEOUT_MS = 15_000;

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {(line: string) => void} [options.log]
 * @returns {{ name: string, send: (message: { to: string, subject: string, text: string, html?: string }) => Promise<void> } | null}
 */
export function createEmailSender(env, { fetchImpl = fetch, log = console.log } = {}) {
  const from = env.CAREER_OPS_AUTH_EMAIL_FROM?.trim();

  if (env.RESEND_API_KEY?.trim()) {
    if (!from || !extractAddress(from)) {
      throw new Error("RESEND_API_KEY is set but CAREER_OPS_AUTH_EMAIL_FROM is missing or not an address");
    }
    const apiKey = env.RESEND_API_KEY.trim();
    return {
      name: "resend",
      async send({ to, subject, text, html }) {
        const res = await fetchImpl("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ from, to: [to], subject, text, ...(html ? { html } : {}) }),
          signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`Resend refused the message (${res.status}): ${await safeText(res)}`);
      },
    };
  }

  if (env.SMTP_HOST?.trim()) {
    const user = env.SMTP_USER?.trim() || "";
    const sender = from || user;
    if (!sender || !extractAddress(sender)) {
      throw new Error("SMTP_HOST is set but neither CAREER_OPS_AUTH_EMAIL_FROM nor SMTP_USER is an address");
    }
    const port = Number.parseInt(env.SMTP_PORT || "465", 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("SMTP_PORT is not a valid port");
    const secure = env.SMTP_SECURE?.trim().toLowerCase() || undefined;
    if (secure && !["tls", "starttls", "none"].includes(secure)) {
      throw new Error('SMTP_SECURE must be "tls", "starttls" or "none"');
    }
    const config = {
      host: env.SMTP_HOST.trim(),
      port,
      secure,
      user,
      // Gmail shows an app password in groups of four; the spaces are not part of it.
      pass: user ? (env.SMTP_PASS ?? "").replace(/\s+/g, "") : "",
      from: sender,
    };
    return {
      name: "smtp",
      async send({ to, subject, text, html }) {
        await sendSmtpMail({ ...config, to, subject, text, html });
      },
    };
  }

  if (devOtpEnabled(env)) {
    return {
      name: "console",
      async send({ to, text }) {
        log(`[auth-dev] Email to ${to}: ${text.split("\n")[0]}`);
      },
    };
  }

  return null;
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {(line: string) => void} [options.log]
 * @returns {{ name: string, send: (message: { to: string, text: string }) => Promise<void> } | null}
 */
export function createSmsSender(env, { fetchImpl = fetch, log = console.log } = {}) {
  const sid = env.TWILIO_ACCOUNT_SID?.trim();
  const token = env.TWILIO_AUTH_TOKEN?.trim();

  if (sid && token) {
    const fromNumber = env.TWILIO_FROM_NUMBER?.trim();
    const messagingService = env.TWILIO_MESSAGING_SERVICE_SID?.trim();
    if (!fromNumber && !messagingService) {
      throw new Error("Twilio is configured but TWILIO_FROM_NUMBER / TWILIO_MESSAGING_SERVICE_SID is missing");
    }
    const auth = Buffer.from(`${sid}:${token}`, "utf8").toString("base64");
    return {
      name: "twilio",
      async send({ to, text }) {
        const body = new URLSearchParams({ To: to, Body: text });
        if (messagingService) body.set("MessagingServiceSid", messagingService);
        else body.set("From", fromNumber);
        const res = await fetchImpl(
          `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`,
          {
            method: "POST",
            headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
            body,
            signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
          },
        );
        if (!res.ok) throw new Error(`Twilio refused the message (${res.status}): ${await safeText(res)}`);
      },
    };
  }

  if (devOtpEnabled(env)) {
    return {
      name: "console",
      async send({ to, text }) {
        log(`[auth-dev] SMS to ${to}: ${text}`);
      },
    };
  }

  return null;
}

export function devOtpEnabled(env) {
  return env.CAREER_OPS_AUTH_DEV_OTP === "1" && env.NODE_ENV !== "production";
}

async function safeText(res) {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "";
  }
}

/** The email that carries a code. */
export function codeEmail({ code, purpose, appName = "Career Ops", minutes = 10 }) {
  const action =
    purpose === "reset" ? "reset your password" : purpose === "signup" ? "finish creating your account" : "sign in";
  const subject = `${code} is your ${appName} code`;
  const text = [
    `Your ${appName} code is ${code}`,
    "",
    `Enter it to ${action}. It expires in ${minutes} minutes.`,
    "If you did not ask for this, you can ignore this email. Nobody can use the code without it.",
  ].join("\n");
  const html = `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#111;line-height:1.5">
<p>Your ${escapeHtml(appName)} code is</p>
<p style="font-size:28px;font-weight:700;letter-spacing:6px;margin:16px 0">${escapeHtml(code)}</p>
<p>Enter it to ${escapeHtml(action)}. It expires in ${minutes} minutes.</p>
<p style="color:#666;font-size:13px">If you did not ask for this, you can ignore this email. Nobody can use the code without it.</p>
</body></html>`;
  return { subject, text, html };
}

/** Sent in place of a code when someone signs up with an address that already has an account. */
export function existingAccountEmail({ appName = "Career Ops", loginUrl }) {
  const subject = `You already have a ${appName} account`;
  const text = [
    `Someone tried to create a ${appName} account with this email address, but one already exists.`,
    "",
    `If that was you, sign in instead${loginUrl ? `: ${loginUrl}` : "."}`,
    "You can use an email code or reset your password from the sign-in page.",
    "If it was not you, no action is needed.",
  ].join("\n");
  return { subject, text };
}

export function codeSms({ code, appName = "Career Ops", minutes = 10 }) {
  return `${code} is your ${appName} code. It expires in ${minutes} minutes. Do not share it.`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

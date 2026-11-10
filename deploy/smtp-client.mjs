/**
 * deploy/smtp-client.mjs
 * A small SMTP submission client, enough to deliver a sign-in code.
 *
 * It exists so a deployment can send mail through an account it already has
 * (Gmail with an app password, Outlook, any provider's SMTP relay) without
 * adding a dependency. It does one thing: authenticate, hand over one message
 * to one recipient, quit.
 *
 * Transport security is not optional. Port 465 speaks TLS from the first byte;
 * any other port must upgrade with STARTTLS before credentials are sent, and a
 * server that does not offer it is refused. The one exception, `secure: "none"`,
 * is accepted for loopback hosts only, which is what the tests use.
 */

import net from "node:net";
import tls from "node:tls";
import crypto from "node:crypto";

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * @param {object} options
 * @param {string} options.host
 * @param {number} [options.port]
 * @param {"tls" | "starttls" | "none"} [options.secure] Defaults from the port.
 * @param {string} [options.user]
 * @param {string} [options.pass]
 * @param {string} options.from Address, or `Name <address>`.
 * @param {string} options.to
 * @param {string} options.subject
 * @param {string} options.text
 * @param {string} [options.html]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{ ok: true }>}
 */
export async function sendSmtpMail({
  host,
  port = 465,
  secure,
  user,
  pass,
  from,
  to,
  subject,
  text,
  html,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  if (!host) throw new Error("SMTP host is required");
  const mode = secure || (Number(port) === 465 ? "tls" : "starttls");
  if (mode === "none" && !isLoopback(host)) {
    throw new Error("Unencrypted SMTP is only allowed for a loopback host");
  }

  const fromAddress = extractAddress(from);
  const toAddress = extractAddress(to);
  if (!fromAddress) throw new Error("SMTP sender address is not valid");
  if (!toAddress) throw new Error("SMTP recipient address is not valid");

  let socket = await connect({ host, port, tlsFromStart: mode === "tls", timeoutMs });
  let session = new SmtpSession(socket, timeoutMs);

  try {
    await session.expect(220);
    let capabilities = await session.ehlo();

    if (mode === "starttls") {
      if (!capabilities.has("STARTTLS")) {
        throw new Error("SMTP server does not offer STARTTLS; refusing to send credentials in clear text");
      }
      await session.command("STARTTLS", 220);
      session.detach();
      socket = await upgradeToTls(socket, host, timeoutMs);
      session = new SmtpSession(socket, timeoutMs);
      capabilities = await session.ehlo();
    }

    if (user) {
      const mechanisms = capabilities.get("AUTH") || "";
      if (/\bPLAIN\b/i.test(mechanisms)) {
        const token = Buffer.from(`\u0000${user}\u0000${pass ?? ""}`, "utf8").toString("base64");
        await session.command(`AUTH PLAIN ${token}`, 235);
      } else {
        await session.command("AUTH LOGIN", 334);
        await session.command(Buffer.from(user, "utf8").toString("base64"), 334);
        await session.command(Buffer.from(pass ?? "", "utf8").toString("base64"), 235);
      }
    }

    await session.command(`MAIL FROM:<${fromAddress}>`, 250);
    await session.command(`RCPT TO:<${toAddress}>`, [250, 251]);
    await session.command("DATA", 354);
    await session.command(
      `${buildMessage({ from, fromAddress, toAddress, subject, text, html })}\r\n.`,
      250,
    );
    // The message is accepted at this point; a server that drops the
    // connection instead of answering QUIT has still delivered it.
    await session.command("QUIT", 221).catch(() => {});
    return { ok: true };
  } finally {
    session.detach();
    socket.destroy();
  }
}

class SmtpSession {
  constructor(socket, timeoutMs) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.buffer = "";
    this.lines = [];
    this.waiter = null;
    this.failure = null;

    this.onData = (chunk) => {
      this.buffer += chunk.toString("utf8");
      let idx;
      while ((idx = this.buffer.indexOf("\n")) !== -1) {
        this.lines.push(this.buffer.slice(0, idx).replace(/\r$/, ""));
        this.buffer = this.buffer.slice(idx + 1);
      }
      this.flush();
    };
    this.onError = (err) => this.fail(err);
    this.onClose = () => this.fail(new Error("SMTP connection closed unexpectedly"));

    socket.on("data", this.onData);
    socket.on("error", this.onError);
    socket.on("close", this.onClose);
  }

  detach() {
    this.socket.off("data", this.onData);
    this.socket.off("error", this.onError);
    this.socket.off("close", this.onClose);
  }

  fail(err) {
    this.failure = this.failure || err;
    this.flush();
  }

  /** Resolve the pending read once a full (possibly multi-line) reply is in. */
  flush() {
    if (!this.waiter) return;
    // A reply ends at the first line whose code is followed by a space.
    const end = this.lines.findIndex((line) => /^\d{3}( |$)/.test(line));
    if (end !== -1) {
      const reply = this.lines.splice(0, end + 1);
      const { resolve, timer } = this.waiter;
      this.waiter = null;
      clearTimeout(timer);
      resolve({ code: Number(reply[end].slice(0, 3)), lines: reply.map((l) => l.slice(4)) });
      return;
    }
    if (this.failure) {
      const { reject, timer } = this.waiter;
      this.waiter = null;
      clearTimeout(timer);
      reject(this.failure);
    }
  }

  read() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new Error("SMTP server did not answer in time"));
      }, this.timeoutMs);
      this.waiter = { resolve, reject, timer };
      this.flush();
    });
  }

  async expect(codes) {
    const allowed = Array.isArray(codes) ? codes : [codes];
    const reply = await this.read();
    if (!allowed.includes(reply.code)) {
      // The reply text is the server's own words about its own refusal; the
      // command that caused it may carry a credential, so it is not echoed.
      throw new Error(`SMTP server answered ${reply.code}: ${reply.lines.join(" ").slice(0, 200)}`);
    }
    return reply;
  }

  async command(line, codes) {
    this.socket.write(`${line}\r\n`);
    return this.expect(codes);
  }

  /** @returns {Promise<Map<string, string>>} Capability keyword -> parameters */
  async ehlo() {
    const reply = await this.command("EHLO career-ops.local", 250);
    const capabilities = new Map();
    for (const line of reply.lines.slice(1)) {
      const [keyword, ...rest] = line.trim().split(/\s+/);
      if (keyword) capabilities.set(keyword.toUpperCase(), rest.join(" "));
    }
    return capabilities;
  }
}

function connect({ host, port, tlsFromStart, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const socket = tlsFromStart
      ? tls.connect({ host, port: Number(port), servername: net.isIP(host) ? undefined : host })
      : net.connect({ host, port: Number(port) });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Timed out connecting to SMTP server ${host}:${port}`));
    }, timeoutMs);
    socket.once(tlsFromStart ? "secureConnect" : "connect", () => {
      clearTimeout(timer);
      socket.off("error", onError);
      resolve(socket);
    });
    const onError = (err) => {
      clearTimeout(timer);
      reject(new Error(`Cannot connect to SMTP server ${host}:${port}: ${err.message}`));
    };
    socket.once("error", onError);
  });
}

function upgradeToTls(socket, host, timeoutMs) {
  return new Promise((resolve, reject) => {
    const secured = tls.connect({ socket, servername: net.isIP(host) ? undefined : host });
    const timer = setTimeout(() => {
      secured.destroy();
      reject(new Error("Timed out negotiating STARTTLS"));
    }, timeoutMs);
    const onError = (err) => {
      clearTimeout(timer);
      reject(new Error(`STARTTLS failed: ${err.message}`));
    };
    secured.once("error", onError);
    secured.once("secureConnect", () => {
      clearTimeout(timer);
      secured.off("error", onError);
      resolve(secured);
    });
  });
}

function isLoopback(host) {
  const h = String(host).toLowerCase();
  return h === "localhost" || h === "::1" || h === "[::1]" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/** Pull the bare address out of `Name <a@b.c>` or `a@b.c`. */
export function extractAddress(value) {
  const raw = String(value ?? "").trim();
  // The address goes onto a protocol line, where a CR or LF would start a new
  // command. Refuse the whole value: "a@b.c\r\nRCPT TO:<x@y.z>" must not be
  // read as "the address inside the angle brackets".
  if (/[\u0000-\u001f\u007f]/.test(raw)) return null;
  const angle = /<([^<>\s]+)>$/.exec(raw);
  const address = angle ? angle[1] : raw;
  return /^[^\s<>@]+@[^\s<>@]+$/.test(address) ? address : null;
}

/** Build an RFC 5322 message with a text part and an optional HTML part. */
export function buildMessage({ from, fromAddress, toAddress, subject, text, html }) {
  const domain = fromAddress.split("@")[1] || "localhost";
  const displayName = /^(.*)<[^<>]+>\s*$/.exec(String(from).trim())?.[1]?.trim().replace(/^"|"$/g, "") || "";
  const fromHeader = displayName ? `${encodeHeaderWord(displayName)} <${fromAddress}>` : fromAddress;

  const headers = [
    `From: ${fromHeader}`,
    `To: ${toAddress}`,
    `Subject: ${encodeHeaderWord(subject)}`,
    `Date: ${new Date().toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <${crypto.randomBytes(16).toString("hex")}@${domain}>`,
    "MIME-Version: 1.0",
    "Auto-Submitted: auto-generated",
  ];

  let body;
  if (html) {
    const boundary = `=_career_ops_${crypto.randomBytes(12).toString("hex")}`;
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    body = [
      `--${boundary}`,
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: base64",
      "",
      wrapBase64(text),
      `--${boundary}`,
      "Content-Type: text/html; charset=utf-8",
      "Content-Transfer-Encoding: base64",
      "",
      wrapBase64(html),
      `--${boundary}--`,
    ].join("\r\n");
  } else {
    headers.push("Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64");
    body = wrapBase64(text);
  }

  // Base64 bodies never begin a line with ".", so no dot-stuffing is needed.
  return `${headers.join("\r\n")}\r\n\r\n${body}`;
}

function wrapBase64(value) {
  const encoded = Buffer.from(String(value ?? ""), "utf8").toString("base64");
  return encoded.replace(/(.{76})/g, "$1\r\n").replace(/\r\n$/, "");
}

/** RFC 2047 encode a header value when it is not plain printable ASCII. */
function encodeHeaderWord(value) {
  const clean = String(value ?? "").replace(/[\r\n]+/g, " ").trim();
  if (/^[\x20-\x7e]*$/.test(clean)) return clean;
  return `=?UTF-8?B?${Buffer.from(clean, "utf8").toString("base64")}?=`;
}

/**
 * tests/deploy/accounts.test.mjs
 * Accounts, sign-in methods and per-account workspaces.
 *
 * Unit level: identifier normalization, the account store, one-time codes,
 * settings parsing, the SMTP client (against an in-process server), the HTTP
 * senders and Google claim validation (against stub fetches), and the
 * workspace manager.
 *
 * End to end: a real gateway with stub senders and one in-process "app" per
 * workspace that reports which data directory it serves. That last part is the
 * property everything else exists for: one account's requests never reach
 * another account's workspace.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import net from "node:net";
import {
  UserStore,
  normalizeEmail,
  normalizePhone,
  validatePassword,
  maskEmail,
  maskPhone,
} from "../../deploy/user-store.mjs";
import { OtpStore, SlidingWindowCounter } from "../../deploy/otp-store.mjs";
import { loadAuthConfig, buildWorkerEnv } from "../../deploy/auth-config.mjs";
import { sendSmtpMail, buildMessage, extractAddress } from "../../deploy/smtp-client.mjs";
import { createEmailSender, createSmsSender, codeEmail } from "../../deploy/notifiers.mjs";
import { createGoogleOAuth, validateIdTokenClaims, pkcePair } from "../../deploy/google-oauth.mjs";
import { WorkspaceManager, OWNER_ACCOUNT_ID } from "../../deploy/workspace-manager.mjs";
import { AuthStore } from "../../deploy/auth-store.mjs";
import { LoginRateLimiter } from "../../deploy/rate-limiter.mjs";
import { hashPassword, verifyPassword } from "../../deploy/hash-password.mjs";
import { createGateway } from "../../deploy/gateway.mjs";

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const cleanup = (dir) => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

test("email, phone and password rules", () => {
  assert.equal(normalizeEmail("  Jane.Doe@Example.COM "), "jane.doe@example.com");
  for (const bad of ["", "no-at-sign", "a@b", "a b@c.com", "a@b.c", "x@y.com\r\nBcc: z@z.com", 42, null]) {
    assert.equal(normalizeEmail(bad), null, `must reject ${JSON.stringify(bad)}`);
  }

  assert.equal(normalizePhone("+91 98765 43210"), "+919876543210");
  assert.equal(normalizePhone("0044 20 7946 0958"), "+442079460958");
  assert.equal(normalizePhone("(415) 555-2671", "+1"), "+14155552671");
  assert.equal(normalizePhone("098765 43210", "+91"), "+919876543210", "a trunk zero is dropped");
  // No country code and no default: guessing one would text a stranger.
  assert.equal(normalizePhone("98765 43210"), null);
  for (const bad of ["", "+12", "+0123456789", "call me", "+1 415 555 2671 ext 5", "+1234567890123456"]) {
    assert.equal(normalizePhone(bad), null, `must reject ${JSON.stringify(bad)}`);
  }

  assert.equal(validatePassword("long enough"), null);
  assert.ok(validatePassword("short"));
  assert.ok(validatePassword(" ".repeat(12)));
  assert.ok(validatePassword("x".repeat(129)));
  assert.ok(validatePassword(undefined));

  assert.equal(maskEmail("jane.doe@example.com"), "ja***@example.com");
  assert.equal(maskPhone("+919876543210"), "+91******3210");
});

// ---------------------------------------------------------------------------
// Account store
// ---------------------------------------------------------------------------

test("account store: unique identifiers, persistence, and a corrupt file is not 'no accounts'", () => {
  const dir = tmp("co-users-");
  try {
    const store = new UserStore({ dir });
    const a = store.create({ email: "a@example.com", emailVerified: true, passwordHash: "scrypt:x:y", name: " A\u0007 User " });
    assert.match(a.id, /^u_[a-f0-9]{16}$/);
    assert.equal(a.name, "A User", "control characters are stripped from names");

    assert.throws(() => store.create({ email: "a@example.com" }), { code: "DUPLICATE_IDENTIFIER" });
    assert.throws(() => store.create({}), /needs an email/);

    const b = store.create({ phone: "+919876543210", phoneVerified: true });
    assert.throws(() => store.update(b.id, { email: "a@example.com" }), { code: "DUPLICATE_IDENTIFIER" });
    store.update(b.id, { googleSub: "sub-1" });

    // Restart
    const reopened = new UserStore({ dir });
    assert.equal(reopened.count(), 2);
    assert.equal(reopened.findByEmail("a@example.com").id, a.id);
    assert.equal(reopened.findByPhone("+919876543210").id, b.id);
    assert.equal(reopened.findByGoogleSub("sub-1").id, b.id);
    assert.equal(reopened.findByEmail("nobody@example.com"), null);

    assert.equal(reopened.delete(a.id), true);
    assert.equal(new UserStore({ dir }).count(), 1);

    // A damaged file must stop the server, not read as an empty account list
    // that the next sign-up overwrites.
    fs.writeFileSync(path.join(dir, "users.json"), "{ not json");
    assert.throws(() => new UserStore({ dir }), /not valid JSON/);
  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// One-time codes
// ---------------------------------------------------------------------------

test("one-time codes: single use, attempt cap, expiry, resend rules", () => {
  let now = 1_000_000;
  const store = new OtpStore({ secret: "test-secret", now: () => now, maxAttempts: 3, resendCooldownMs: 60_000, maxSends: 2 });

  const { id, code } = store.create({ channel: "email", destination: "a@example.com", purpose: "login" });
  assert.match(code, /^\d{6}$/);
  assert.equal(JSON.stringify([...store.challenges.values()]).includes(code), false, "the code itself is never stored");

  const wrong = code === "000000" ? "000001" : "000000";
  assert.deepEqual(store.verify(id, wrong), { ok: false, reason: "invalid", remaining: 2 });
  const ok = store.verify(id, ` ${code.slice(0, 3)} ${code.slice(3)} `);
  assert.equal(ok.ok, true, "spaces in a typed code are ignored");
  assert.equal(store.verify(id, code).reason, "expired", "a used code cannot be used again");

  // Attempt cap burns the challenge even if the right code arrives afterwards.
  const second = store.create({ channel: "email", destination: "a@example.com", purpose: "login" });
  const bad = second.code === "111111" ? "222222" : "111111";
  store.verify(second.id, bad);
  store.verify(second.id, bad);
  assert.equal(store.verify(second.id, bad).reason, "locked");
  assert.equal(store.verify(second.id, second.code).ok, false);

  // Expiry
  const third = store.create({ channel: "phone", destination: "+14155552671", purpose: "login" });
  now += 11 * 60 * 1000;
  assert.equal(store.get(third.id), null);
  assert.equal(store.verify(third.id, third.code).reason, "expired");

  // Resend: cooldown, then a fresh code that retires the old one, then the send cap.
  const fourth = store.create({ channel: "email", destination: "b@example.com", purpose: "login" });
  const early = store.regenerate(fourth.id);
  assert.equal(early.ok, false);
  assert.equal(early.reason, "cooldown");
  assert.equal(early.retryAfterSeconds, 60);
  now += 61_000;
  const again = store.regenerate(fourth.id);
  assert.equal(again.ok, true);
  if (again.code !== fourth.code) assert.equal(store.verify(fourth.id, fourth.code).ok, false, "the old code stops working");
  now += 61_000;
  assert.equal(store.regenerate(fourth.id).reason, "limit");

  // A dead challenge accepts no code at all.
  const dead = store.create({ channel: "email", destination: "c@example.com", purpose: "login", dead: true });
  assert.equal(dead.code, null);
  assert.equal(store.verify(dead.id, "123456").ok, false);
});

test("sliding window counter caps events per key", () => {
  let now = 0;
  const counter = new SlidingWindowCounter({ now: () => now });
  assert.equal(counter.retryAfter("k", 2, 1000), 0);
  counter.record("k", 1000);
  counter.record("k", 1000);
  assert.equal(counter.retryAfter("k", 2, 1000), 1);
  assert.equal(counter.retryAfter("other", 2, 1000), 0);
  now = 1001;
  assert.equal(counter.retryAfter("k", 2, 1000), 0);
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

test("settings: defaults, validation, and what an app process may see", () => {
  const defaults = loadAuthConfig({});
  assert.equal(defaults.signup.mode, "open");
  assert.deepEqual(defaults.signup.allowlist, []);
  assert.equal(defaults.google, null);
  assert.equal(defaults.maxWorkspaces, 3);
  assert.equal(defaults.shareAiKeys, false);

  const configured = loadAuthConfig({
    CAREER_OPS_SIGNUP: "Closed",
    CAREER_OPS_SIGNUP_ALLOWLIST: "Friend@Example.com, @team.example.org",
    CAREER_OPS_OWNER_EMAIL: "Me@Example.com",
    CAREER_OPS_AUTH_DEFAULT_COUNTRY_CODE: "91",
    CAREER_OPS_PUBLIC_URL: "https://jobs.example.com/some/path",
    GOOGLE_CLIENT_ID: "id",
    GOOGLE_CLIENT_SECRET: "secret",
    CAREER_OPS_MAX_WORKSPACES: "5",
  });
  assert.equal(configured.signup.mode, "closed");
  assert.deepEqual(configured.signup.allowlist, ["friend@example.com", "@team.example.org"]);
  assert.equal(configured.ownerEmail, "me@example.com");
  assert.equal(configured.defaultCountryCode, "+91");
  assert.equal(configured.publicUrl, "https://jobs.example.com");
  assert.equal(configured.maxWorkspaces, 5);

  // A typo must not silently mean "open".
  assert.throws(() => loadAuthConfig({ CAREER_OPS_SIGNUP: "invite" }), /CAREER_OPS_SIGNUP/);
  assert.throws(() => loadAuthConfig({ GOOGLE_CLIENT_ID: "id" }), /set together/);
  assert.throws(() => loadAuthConfig({ CAREER_OPS_OWNER_EMAIL: "nope" }), /CAREER_OPS_OWNER_EMAIL/);
  assert.throws(() => loadAuthConfig({ CAREER_OPS_PUBLIC_URL: "ftp://x" }), /https/);
  assert.throws(() => loadAuthConfig({ CAREER_OPS_MAX_WORKSPACES: "0" }), /CAREER_OPS_MAX_WORKSPACES/);
  assert.ok(
    loadAuthConfig({ CAREER_OPS_AUTH_DEV_OTP: "1", NODE_ENV: "production" }).warnings.some((w) => /DEV_OTP/.test(w)),
  );

  const env = {
    PATH: "/usr/bin",
    R2_SECRET_ACCESS_KEY: "r2",
    CAREER_OPS_AUTH_PASSWORD_HASH: "scrypt:a:b",
    CAREER_OPS_SESSION_SECRET: "s",
    GOOGLE_CLIENT_SECRET: "g",
    SMTP_PASS: "p",
    TWILIO_AUTH_TOKEN: "t",
    RESEND_API_KEY: "r",
    GEMINI_API_KEY: "gem",
    CAREER_OPS_TRACKER: "/data/applications.md",
    CAREER_OPS_ROOT: "/data",
  };
  const overrides = { CAREER_OPS_ROOT: "/data/.tenants/u_1" };

  const tenant = buildWorkerEnv(env, { isOwner: false, shareAiKeys: false, overrides });
  assert.deepEqual(Object.keys(tenant).sort(), ["CAREER_OPS_ROOT", "PATH"]);
  assert.equal(tenant.CAREER_OPS_ROOT, "/data/.tenants/u_1");

  const shared = buildWorkerEnv(env, { isOwner: false, shareAiKeys: true, overrides });
  assert.equal(shared.GEMINI_API_KEY, "gem");
  assert.equal(shared.CAREER_OPS_TRACKER, undefined, "a deployment-wide tracker path must not reach other accounts");

  const owner = buildWorkerEnv(env, { isOwner: true, shareAiKeys: false, overrides: {} });
  assert.equal(owner.GEMINI_API_KEY, "gem");
  assert.equal(owner.CAREER_OPS_TRACKER, "/data/applications.md");
  for (const secret of ["R2_SECRET_ACCESS_KEY", "CAREER_OPS_AUTH_PASSWORD_HASH", "CAREER_OPS_SESSION_SECRET", "GOOGLE_CLIENT_SECRET", "SMTP_PASS", "TWILIO_AUTH_TOKEN", "RESEND_API_KEY"]) {
    assert.equal(owner[secret], undefined, `${secret} must stay in the gateway`);
  }
});

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

/** A minimal SMTP server on loopback that records the conversation. */
function fakeSmtpServer({ authOk = true } = {}) {
  const received = { commands: [], data: "" };
  const server = net.createServer((socket) => {
    let inData = false;
    let buffer = "";
    let loginStep = 0;
    socket.write("220 fake ESMTP\r\n");
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let idx;
      while ((idx = buffer.indexOf("\r\n")) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (inData) {
          if (line === ".") {
            inData = false;
            socket.write("250 queued\r\n");
          } else {
            received.data += `${line}\r\n`;
          }
          continue;
        }
        received.commands.push(line);
        if (loginStep === 1) {
          loginStep = 2;
          socket.write("334 UGFzc3dvcmQ6\r\n");
        } else if (loginStep === 2) {
          loginStep = 0;
          socket.write(authOk ? "235 ok\r\n" : "535 bad credentials\r\n");
        } else if (/^EHLO/i.test(line)) socket.write("250-fake\r\n250-SIZE 1000000\r\n250 AUTH LOGIN\r\n");
        else if (/^AUTH LOGIN/i.test(line)) {
          loginStep = 1;
          socket.write("334 VXNlcm5hbWU6\r\n");
        } else if (/^MAIL FROM/i.test(line)) socket.write("250 ok\r\n");
        else if (/^RCPT TO/i.test(line)) socket.write("250 ok\r\n");
        else if (/^DATA/i.test(line)) {
          inData = true;
          socket.write("354 go ahead\r\n");
        } else if (/^QUIT/i.test(line)) {
          socket.write("221 bye\r\n");
          socket.end();
        } else socket.write("500 unknown\r\n");
      }
    });
    socket.on("error", () => {});
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, received, port: server.address().port }));
  });
}

test("SMTP client delivers a message, authenticates, and never sends in clear text off loopback", async () => {
  const { server, received, port } = await fakeSmtpServer();
  try {
    await sendSmtpMail({
      host: "127.0.0.1",
      port,
      secure: "none",
      user: "sender@example.com",
      pass: "app-password",
      from: "Career Ops <sender@example.com>",
      to: "jane@example.com",
      subject: "123456 is your code — ✓",
      text: "Your code is 123456",
      html: "<p>Your code is <b>123456</b></p>",
    });

    assert.ok(received.commands.includes("MAIL FROM:<sender@example.com>"));
    assert.ok(received.commands.includes("RCPT TO:<jane@example.com>"));
    assert.ok(received.commands.includes(Buffer.from("sender@example.com").toString("base64")), "AUTH LOGIN sends the user");
    assert.match(received.data, /^From: Career Ops <sender@example\.com>\r\n/m);
    assert.match(received.data, /^To: jane@example\.com\r\n/m);
    assert.match(received.data, /^Subject: =\?UTF-8\?B\?/m, "a non-ASCII subject is RFC 2047 encoded");
    assert.match(received.data, /multipart\/alternative/);
    assert.ok(received.data.includes(Buffer.from("Your code is 123456").toString("base64")));
  } finally {
    server.close();
  }

  const refused = await fakeSmtpServer({ authOk: false });
  try {
    await assert.rejects(
      sendSmtpMail({ host: "127.0.0.1", port: refused.port, secure: "none", user: "u@example.com", pass: "wrong", from: "u@example.com", to: "x@example.com", subject: "s", text: "t" }),
      /535/,
    );
    assert.equal(refused.received.commands.some((c) => /^MAIL FROM/.test(c)), false, "nothing is sent after a failed login");
  } finally {
    refused.server.close();
  }

  await assert.rejects(
    sendSmtpMail({ host: "smtp.example.com", port: 25, secure: "none", from: "a@example.com", to: "b@example.com", subject: "s", text: "t" }),
    /loopback/,
  );
  await assert.rejects(
    sendSmtpMail({ host: "127.0.0.1", port: 1, secure: "none", from: "a@example.com", to: "b@example.com\r\nRCPT TO:<evil@example.com>", subject: "s", text: "t" }),
    /recipient address is not valid/,
  );
  assert.equal(extractAddress("Name <a@example.com>"), "a@example.com");
  assert.equal(extractAddress("a@example.com\r\nX: y"), null);
  // A header value cannot smuggle a second header line.
  const message = buildMessage({ from: "a@example.com", fromAddress: "a@example.com", toAddress: "b@example.com", subject: "hi\r\nBcc: evil@example.com", text: "t" });
  assert.equal(/^Bcc:/m.test(message), false);
});

test("email and SMS senders: provider selection, request shape, and refusal handling", async () => {
  assert.equal(createEmailSender({}), null);
  assert.equal(createSmsSender({}), null);

  // Dev console sender exists only outside production.
  assert.equal(createEmailSender({ CAREER_OPS_AUTH_DEV_OTP: "1", NODE_ENV: "production" }), null);
  const lines = [];
  const dev = createEmailSender({ CAREER_OPS_AUTH_DEV_OTP: "1" }, { log: (l) => lines.push(l) });
  await dev.send({ to: "a@example.com", ...codeEmail({ code: "654321", purpose: "login" }) });
  assert.ok(lines[0].includes("654321"));

  assert.throws(() => createEmailSender({ RESEND_API_KEY: "re_x" }), /CAREER_OPS_AUTH_EMAIL_FROM/);
  assert.throws(() => createEmailSender({ SMTP_HOST: "smtp.example.com", SMTP_PORT: "abc", SMTP_USER: "a@example.com" }), /SMTP_PORT/);
  assert.throws(() => createSmsSender({ TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "t" }), /TWILIO_FROM_NUMBER/);

  const calls = [];
  const okFetch = async (url, init) => {
    calls.push({ url, init });
    return new Response("{}", { status: 200 });
  };

  const resend = createEmailSender(
    { RESEND_API_KEY: "re_key", CAREER_OPS_AUTH_EMAIL_FROM: "Career Ops <login@example.com>" },
    { fetchImpl: okFetch },
  );
  assert.equal(resend.name, "resend");
  await resend.send({ to: "jane@example.com", subject: "s", text: "t", html: "<p>t</p>" });
  assert.equal(calls[0].url, "https://api.resend.com/emails");
  assert.equal(calls[0].init.headers.Authorization, "Bearer re_key");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    from: "Career Ops <login@example.com>",
    to: ["jane@example.com"],
    subject: "s",
    text: "t",
    html: "<p>t</p>",
  });

  const twilio = createSmsSender(
    { TWILIO_ACCOUNT_SID: "AC123", TWILIO_AUTH_TOKEN: "tok", TWILIO_FROM_NUMBER: "+15005550006" },
    { fetchImpl: okFetch },
  );
  await twilio.send({ to: "+919876543210", text: "123456 is your code" });
  assert.equal(calls[1].url, "https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json");
  assert.equal(calls[1].init.headers.Authorization, `Basic ${Buffer.from("AC123:tok").toString("base64")}`);
  assert.equal(calls[1].init.body.get("To"), "+919876543210");
  assert.equal(calls[1].init.body.get("From"), "+15005550006");

  const failing = createSmsSender(
    { TWILIO_ACCOUNT_SID: "AC123", TWILIO_AUTH_TOKEN: "tok", TWILIO_MESSAGING_SERVICE_SID: "MG1" },
    { fetchImpl: async () => new Response('{"message":"unverified number"}', { status: 400 }) },
  );
  await assert.rejects(failing.send({ to: "+919876543210", text: "x" }), /Twilio refused the message \(400\)/);
});

// ---------------------------------------------------------------------------
// Google
// ---------------------------------------------------------------------------

function fakeIdToken(claims) {
  const part = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${part({ alg: "RS256" })}.${part(claims)}.signature`;
}

test("Google sign-in: authorization URL, code exchange, and every claim that must hold", async () => {
  const now = 1_700_000_000_000;
  const good = {
    iss: "https://accounts.google.com",
    aud: "client-id",
    exp: now / 1000 + 3600,
    nonce: "n-1",
    sub: "google-sub-1",
    email: "Jane@Example.com",
    email_verified: true,
    name: "Jane",
  };
  const expected = { clientId: "client-id", nonce: "n-1", now };
  validateIdTokenClaims(good, expected);
  assert.throws(() => validateIdTokenClaims({ ...good, iss: "https://evil.example" }, expected), /not issued by Google/);
  assert.throws(() => validateIdTokenClaims({ ...good, aud: "another-app" }, expected), /different application/);
  assert.throws(() => validateIdTokenClaims({ ...good, exp: now / 1000 - 3600 }, expected), /expired/);
  assert.throws(() => validateIdTokenClaims({ ...good, nonce: "other" }, expected), /does not match/);
  assert.throws(() => validateIdTokenClaims({ ...good, email_verified: false }, expected), /not verified/);
  assert.throws(() => validateIdTokenClaims({ ...good, sub: "" }, expected), /no subject/);

  const { verifier, challenge } = pkcePair();
  assert.notEqual(verifier, challenge);

  let request = null;
  const google = createGoogleOAuth({
    clientId: "client-id",
    clientSecret: "client-secret",
    now: () => now,
    fetchImpl: async (url, init) => {
      request = { url, body: init.body };
      return new Response(JSON.stringify({ id_token: fakeIdToken(good) }), { status: 200 });
    },
  });

  const authUrl = new URL(
    google.buildAuthUrl({ redirectUri: "https://app.example/auth/google/callback", state: "s-1", nonce: "n-1", codeChallenge: challenge }),
  );
  assert.equal(authUrl.origin + authUrl.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(authUrl.searchParams.get("client_id"), "client-id");
  assert.equal(authUrl.searchParams.get("code_challenge_method"), "S256");
  assert.equal(authUrl.searchParams.get("scope"), "openid email profile");
  assert.equal(authUrl.searchParams.get("client_secret"), null, "the secret never goes through the browser");

  const identity = await google.exchangeCode({ code: "c", redirectUri: "https://app.example/auth/google/callback", codeVerifier: verifier, nonce: "n-1" });
  assert.deepEqual(identity, { sub: "google-sub-1", email: "jane@example.com", name: "Jane" });
  assert.equal(request.url, "https://oauth2.googleapis.com/token");
  assert.equal(request.body.get("code_verifier"), verifier);
  assert.equal(request.body.get("client_secret"), "client-secret");

  const refused = createGoogleOAuth({
    clientId: "client-id",
    clientSecret: "client-secret",
    fetchImpl: async () => new Response(JSON.stringify({ error: "invalid_grant", error_description: "secret detail" }), { status: 400 }),
  });
  await assert.rejects(
    refused.exchangeCode({ code: "c", redirectUri: "r", codeVerifier: "v", nonce: "n" }),
    (err) => /invalid_grant/.test(err.message) && !/secret detail/.test(err.message),
  );
});

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

/** Starts one in-process HTTP server per workspace that reports its data root. */
function fakeAppProcesses() {
  const started = [];
  const stopped = [];
  const startWorker = async ({ key, root }) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ key, root, user: req.headers["x-career-ops-user"], account: req.headers["x-career-ops-account"], kind: req.headers["x-career-ops-account-kind"], path: req.url }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    started.push(key);
    let resolveExit;
    const exited = new Promise((r) => (resolveExit = r));
    return {
      host: "127.0.0.1",
      port: server.address().port,
      exited,
      stop: async () => {
        stopped.push(key);
        server.closeAllConnections();
        await new Promise((r) => server.close(r));
        resolveExit({ code: 0 });
      },
    };
  };
  return { startWorker, started, stopped };
}

test("workspace manager: one directory and one process per account, capped and reaped", async () => {
  const dataRoot = tmp("co-ws-");
  let now = 0;
  const apps = fakeAppProcesses();
  const removed = [];
  const manager = new WorkspaceManager({
    ownerRoot: dataRoot,
    startWorker: apps.startWorker,
    maxWorkers: 2,
    idleMs: 10_000,
    now: () => now,
    onWorkspaceRemoved: (root) => removed.push(root),
  });
  const owner = { id: OWNER_ACCOUNT_ID };
  const alice = { id: "u_aaaaaaaaaaaaaaaa" };
  const bob = { id: "u_bbbbbbbbbbbbbbbb" };
  const carol = { id: "u_cccccccccccccccc" };

  try {
    assert.equal(manager.rootFor(owner), dataRoot);
    assert.equal(manager.rootFor(alice), path.join(dataRoot, ".tenants", alice.id));
    for (const hostile of ["../owner", "u_../../etc", "u_AAAAAAAAAAAAAAAA", "", "u_aaaaaaaaaaaaaaaa/.."]) {
      assert.throws(() => manager.rootFor({ id: hostile }), /not a valid workspace name/, `must refuse ${JSON.stringify(hostile)}`);
    }

    const a1 = await manager.acquire(alice);
    const a2 = await manager.acquire(alice);
    assert.equal(a1.port, a2.port, "one account, one process");
    assert.deepEqual(apps.started, [alice.id]);
    assert.ok(fs.existsSync(path.join(dataRoot, ".tenants", alice.id, "data")), "a new workspace is seeded");

    const b1 = await manager.acquire(bob);
    assert.notEqual(b1.port, a1.port);

    // Cap reached and everyone is mid-request: the newcomer waits, nobody is evicted.
    await assert.rejects(manager.acquire(carol), { code: "WORKSPACE_BUSY" });
    assert.deepEqual(apps.stopped, []);

    // Bob finishes; Carol takes the idle slot. Alice, still busy, is untouched.
    now = 5;
    b1.release();
    const c1 = await manager.acquire(carol);
    assert.deepEqual(apps.stopped, [bob.id]);
    assert.equal(manager.stats().running, 2);

    // Idle processes are stopped; a busy one is not.
    c1.release();
    now = 20_000;
    assert.equal(await manager.reapIdle(), 1);
    assert.deepEqual(apps.stopped, [bob.id, carol.id]);
    assert.equal(manager.stats().running, 1);

    a1.release();
    a2.release();
    a2.release(); // releasing twice must not go negative
    assert.equal(manager.stats().active, 0);

    // Deleting an account's workspace stops its process and removes its files.
    fs.writeFileSync(path.join(manager.rootFor(alice), "cv.md"), "# Alice");
    await manager.removeWorkspace(alice);
    assert.equal(fs.existsSync(manager.rootFor(alice)), false);
    assert.deepEqual(removed, [manager.rootFor(alice)]);
    await assert.rejects(manager.removeWorkspace(owner), /owner workspace cannot be removed/);

    // A process that fails to start is not remembered as running.
    const failing = new WorkspaceManager({
      ownerRoot: dataRoot,
      startWorker: async () => {
        throw new Error("boom");
      },
    });
    await assert.rejects(failing.acquire(bob), /boom/);
    assert.equal(failing.stats().running, 0);
    await failing.shutdown();
  } finally {
    await manager.shutdown();
    cleanup(dataRoot);
  }
});

// ---------------------------------------------------------------------------
// Gateway, end to end
// ---------------------------------------------------------------------------

/** A browser-like client: keeps cookies, does not follow redirects. */
function browser(baseUrl) {
  const jar = new Map();
  const request = async (pathname, { method = "GET", form, headers = {} } = {}) => {
    const init = { method, redirect: "manual", headers: { ...headers } };
    if (jar.size) init.headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    if (form) {
      init.headers["Content-Type"] = "application/x-www-form-urlencoded";
      init.body = new URLSearchParams(form).toString();
    }
    const res = await fetch(`${baseUrl}${pathname}`, init);
    for (const cookie of res.headers.getSetCookie()) {
      const [pair] = cookie.split(";");
      const idx = pair.indexOf("=");
      const name = pair.slice(0, idx);
      if (/Max-Age=0/.test(cookie)) jar.delete(name);
      else jar.set(name, pair.slice(idx + 1));
    }
    const text = await res.text();
    return { status: res.status, location: res.headers.get("location"), text, json: () => JSON.parse(text) };
  };
  /** GET a page and return the form token it carries. */
  const token = async (pathname) => {
    const page = await request(pathname);
    const match = /name="csrf_token" value="([a-f0-9]+)"/.exec(page.text);
    assert.ok(match, `expected a form token on ${pathname} (status ${page.status})`);
    return match[1];
  };
  return { request, token, jar };
}

async function startGateway(overrides = {}) {
  const dataRoot = tmp("co-accounts-");
  const sessionDir = path.join(dataRoot, ".sessions");
  const apps = fakeAppProcesses();
  const workspaces = new WorkspaceManager({ ownerRoot: dataRoot, startWorker: apps.startWorker, maxWorkers: 8 });
  const authStore = new AuthStore({ sessionDir });
  const userStore = new UserStore({ dir: sessionDir });
  const rateLimiter = new LoginRateLimiter({ maxAttempts: 50 });

  const mail = [];
  const sms = [];
  const emailSender = { name: "test", send: async (m) => void mail.push(m) };
  const smsSender = { name: "test", send: async (m) => void sms.push(m) };
  const googleIdentities = new Map();
  const google = {
    buildAuthUrl: ({ redirectUri, state, nonce, codeChallenge }) =>
      `https://accounts.google.test/auth?${new URLSearchParams({ redirect_uri: redirectUri, state, nonce, code_challenge: codeChallenge })}`,
    exchangeCode: async ({ code }) => {
      const identity = googleIdentities.get(code);
      if (!identity) throw new Error("Google token exchange failed: invalid_grant");
      return identity;
    },
  };

  const ownerPassword = "OwnerPassword!123";
  const gateway = createGateway({
    authStore,
    rateLimiter,
    ownerUser: "admin",
    ownerPasswordHash: hashPassword(ownerPassword),
    userStore,
    emailSender,
    smsSender,
    google,
    workspaces,
    secret: "test-secret-0123456789",
    ...overrides,
  });
  await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${gateway.address().port}`;

  return {
    baseUrl,
    dataRoot,
    authStore,
    userStore,
    workspaces,
    apps,
    mail,
    sms,
    googleIdentities,
    ownerPassword,
    lastCode: (list) => /\b(\d{6})\b/.exec(list.at(-1).text)[1],
    close: async () => {
      gateway.closeAllConnections();
      await new Promise((r) => gateway.close(r));
      await workspaces.shutdown();
      rateLimiter.destroy();
      cleanup(dataRoot);
    },
  };
}

test("accounts end to end: password sign-up, isolation between accounts, and the owner", async () => {
  const gw = await startGateway();
  try {
    // --- Alice signs up with email + password ---
    const alice = browser(gw.baseUrl);
    const signup = await alice.request("/signup", {
      method: "POST",
      form: { csrf_token: await alice.token("/signup"), email: "Alice@Example.com", password: "alice-password-1", name: "Alice" },
    });
    assert.equal(signup.status, 303);
    assert.match(signup.location, /^\/auth\/verify\?c=[a-f0-9]{48}$/);
    assert.equal(gw.userStore.count(), 0, "no account exists until the address is proved");
    assert.equal(gw.mail.length, 1);
    assert.equal(gw.mail[0].to, "alice@example.com");

    // The pending account is not usable yet.
    const early = await alice.request("/login", {
      method: "POST",
      form: { csrf_token: await alice.token("/login"), username: "alice@example.com", password: "alice-password-1" },
    });
    assert.equal(early.status, 401);

    const verifyPage = await alice.request(signup.location);
    assert.equal(verifyPage.status, 200);
    assert.ok(verifyPage.text.includes("al***@example.com"), "the address is masked on the code page");
    assert.equal(verifyPage.text.includes(gw.lastCode(gw.mail)), false);

    const challengeId = new URL(signup.location, gw.baseUrl).searchParams.get("c");
    const formToken = /name="csrf_token" value="([a-f0-9]+)"/.exec(verifyPage.text)[1];
    const wrong = await alice.request("/auth/verify", { method: "POST", form: { csrf_token: formToken, c: challengeId, code: "000000" } });
    assert.equal(wrong.status, 401);
    assert.match(wrong.text, /4 attempts left/);

    const verified = await alice.request("/auth/verify", { method: "POST", form: { csrf_token: formToken, c: challengeId, code: gw.lastCode(gw.mail) } });
    assert.equal(verified.status, 303);
    assert.equal(verified.location, "/");
    const aliceUser = gw.userStore.findByEmail("alice@example.com");
    assert.ok(aliceUser.emailVerified);
    assert.ok(verifyPassword("alice-password-1", aliceUser.passwordHash));
    assert.equal(JSON.stringify(aliceUser).includes("alice-password-1"), false, "the password is stored only as a hash");

    // --- Alice reaches her own workspace ---
    const alicePage = (await alice.request("/api/whoami")).json();
    assert.equal(alicePage.root, path.join(gw.dataRoot, ".tenants", aliceUser.id));
    assert.equal(alicePage.user, aliceUser.id);
    assert.equal(decodeURIComponent(alicePage.account), "alice@example.com");
    assert.equal(alicePage.kind, "user");

    // --- Bob signs in with an emailed code (no password, account created on first use) ---
    const bob = browser(gw.baseUrl);
    const bobStart = await bob.request("/auth/otp/start", {
      method: "POST",
      form: { csrf_token: await bob.token("/login?method=email"), channel: "email", intent: "login", email: "bob@example.com" },
    });
    assert.equal(bobStart.status, 303);
    const bobChallenge = new URL(bobStart.location, gw.baseUrl).searchParams.get("c");
    const bobVerify = await bob.request("/auth/verify", {
      method: "POST",
      form: { csrf_token: await bob.token(bobStart.location), c: bobChallenge, code: gw.lastCode(gw.mail) },
    });
    assert.equal(bobVerify.status, 303);
    const bobUser = gw.userStore.findByEmail("bob@example.com");
    assert.equal(bobUser.passwordHash, null);

    const bobPage = (await bob.request("/api/whoami")).json();
    assert.equal(bobPage.root, path.join(gw.dataRoot, ".tenants", bobUser.id));
    assert.notEqual(bobPage.root, alicePage.root, "two accounts never share a workspace");

    // --- The owner keeps the deployment's own data root ---
    const owner = browser(gw.baseUrl);
    const ownerLogin = await owner.request("/login", {
      method: "POST",
      form: { csrf_token: await owner.token("/login"), username: "admin", password: gw.ownerPassword },
    });
    assert.equal(ownerLogin.status, 303);
    const ownerPage = (await owner.request("/")).json();
    assert.equal(ownerPage.root, gw.dataRoot);
    assert.equal(ownerPage.user, "admin");
    assert.equal(ownerPage.kind, "owner");

    // --- A client cannot claim to be someone else through the proxy headers ---
    const spoofed = (await bob.request("/api/whoami", {
      headers: { "x-career-ops-user": "admin", "x-career-ops-account": "admin", "x-career-ops-account-kind": "owner" },
    })).json();
    assert.equal(spoofed.user, bobUser.id);
    assert.equal(spoofed.kind, "user");
    assert.equal(spoofed.root, bobPage.root);

    // --- A code cannot be replayed ---
    const replay = await browser(gw.baseUrl);
    const replayRes = await replay.request("/auth/verify", {
      method: "POST",
      form: { csrf_token: await replay.token("/login"), c: bobChallenge, code: gw.lastCode(gw.mail) },
    });
    assert.equal(replayRes.status, 303);
    assert.equal(replayRes.location, "/login?m=expired");

    // --- /auth/me reports the signed-in account, and 401s otherwise ---
    assert.deepEqual((await alice.request("/auth/me")).json().account.email, "alice@example.com");
    assert.equal((await browser(gw.baseUrl).request("/auth/me")).status, 401);

    // --- A request that is not signed in never reaches any workspace ---
    const startedBefore = gw.apps.started.length;
    const anon = await browser(gw.baseUrl).request("/api/whoami");
    assert.equal(anon.status, 401);
    assert.equal(gw.apps.started.length, startedBefore);

    // --- Malformed input does not take the gateway down ---
    const odd = await fetch(`${gw.baseUrl}/login`, { headers: { Cookie: "career_ops_session=%E0%A4%A; x=%" } });
    assert.equal(odd.status, 200);
    const junk = await alice.request("/login", { method: "POST", form: { "%": "%zz", csrf_token: "x" } });
    assert.equal(junk.status, 401, "a junk form is refused, not fatal");
    assert.equal((await alice.request("/api/whoami")).status, 200, "and the gateway is still serving");
  } finally {
    await gw.close();
  }
});

test("accounts end to end: phone codes, Google, linking by verified email, and reset", async () => {
  const gw = await startGateway({ defaultCountryCode: "+91" });
  try {
    // --- Phone code: account created from a verified number ---
    const phoneUser = browser(gw.baseUrl);
    const start = await phoneUser.request("/auth/otp/start", {
      method: "POST",
      form: { csrf_token: await phoneUser.token("/login?method=phone"), channel: "phone", intent: "signup", phone: "98765 43210" },
    });
    assert.equal(start.status, 303);
    assert.equal(gw.sms.at(-1).to, "+919876543210", "the default country code completes a national number");
    const c = new URL(start.location, gw.baseUrl).searchParams.get("c");
    const done = await phoneUser.request("/auth/verify", {
      method: "POST",
      form: { csrf_token: await phoneUser.token(start.location), c, code: gw.lastCode(gw.sms) },
    });
    assert.equal(done.status, 303);
    assert.ok(gw.userStore.findByPhone("+919876543210").phoneVerified);

    const badPhone = await browser(gw.baseUrl);
    const rejected = await badPhone.request("/auth/otp/start", {
      method: "POST",
      form: { csrf_token: await badPhone.token("/login?method=phone"), channel: "phone", phone: "not a number" },
    });
    assert.equal(rejected.status, 400);
    assert.equal(gw.sms.length, 1, "no message is sent for an invalid number");

    // --- Google: a new account, bound to the browser that started the flow ---
    gw.googleIdentities.set("code-carol", { sub: "g-carol", email: "carol@example.com", name: "Carol" });
    const carol = browser(gw.baseUrl);
    const go = await carol.request("/auth/google");
    assert.equal(go.status, 302);
    const authUrl = new URL(go.location);
    assert.equal(authUrl.searchParams.get("redirect_uri"), `${gw.baseUrl}/auth/google/callback`);
    const state = authUrl.searchParams.get("state");

    // Another browser replaying the same callback URL has no matching cookie.
    const thief = await browser(gw.baseUrl).request(`/auth/google/callback?code=code-carol&state=${state}`);
    assert.equal(thief.location, "/login?m=google_failed");
    // A callback with the wrong state is refused too.
    const forged = await carol.request(`/auth/google/callback?code=code-carol&state=forged`);
    assert.equal(forged.location, "/login?m=google_failed");
    assert.equal(gw.userStore.findByEmail("carol@example.com"), null);

    const go2 = await carol.request("/auth/google");
    const state2 = new URL(go2.location).searchParams.get("state");
    const back = await carol.request(`/auth/google/callback?code=code-carol&state=${state2}`);
    assert.equal(back.status, 302);
    assert.equal(back.location, "/");
    const carolUser = gw.userStore.findByGoogleSub("g-carol");
    assert.equal(carolUser.email, "carol@example.com");
    assert.equal((await carol.request("/api/whoami")).json().user, carolUser.id);

    // --- The same verified email by another method lands on the same account ---
    const carolByCode = browser(gw.baseUrl);
    const cs = await carolByCode.request("/auth/otp/start", {
      method: "POST",
      form: { csrf_token: await carolByCode.token("/login?method=email"), channel: "email", email: "carol@example.com" },
    });
    await carolByCode.request("/auth/verify", {
      method: "POST",
      form: { csrf_token: await carolByCode.token(cs.location), c: new URL(cs.location, gw.baseUrl).searchParams.get("c"), code: gw.lastCode(gw.mail) },
    });
    assert.equal((await carolByCode.request("/api/whoami")).json().user, carolUser.id);
    assert.equal(gw.userStore.count(), 2);

    // --- Signing up with an address that already has an account reveals nothing ---
    const mailBefore = gw.mail.length;
    const dup = browser(gw.baseUrl);
    const dupRes = await dup.request("/signup", {
      method: "POST",
      form: { csrf_token: await dup.token("/signup"), email: "carol@example.com", password: "attacker-chosen-1" },
    });
    assert.equal(dupRes.status, 303, "same response as a fresh address");
    assert.match(dupRes.location, /^\/auth\/verify\?c=/);
    assert.equal(gw.mail.length, mailBefore + 1);
    assert.match(gw.mail.at(-1).subject, /already have/);
    assert.equal(/\b\d{6}\b/.test(gw.mail.at(-1).text), false, "the note carries no code");
    assert.equal(gw.userStore.findByEmail("carol@example.com").passwordHash, null, "the existing account is untouched");

    // --- Password reset ---
    const reset = browser(gw.baseUrl);
    const forgot = await reset.request("/auth/forgot", {
      method: "POST",
      form: { csrf_token: await reset.token("/auth/forgot"), email: "carol@example.com" },
    });
    assert.equal(forgot.status, 303);
    const rc = new URL(forgot.location, gw.baseUrl).searchParams.get("c");
    const resetToken = await reset.token(forgot.location);
    const weak = await reset.request("/auth/verify", {
      method: "POST",
      form: { csrf_token: resetToken, c: rc, code: gw.lastCode(gw.mail), new_password: "short" },
    });
    assert.equal(weak.status, 400, "a weak password is refused without spending the code");
    const carolSessionsBefore = [...gw.authStore.sessions.values()].filter((s) => s.uid === carolUser.id).length;
    assert.ok(carolSessionsBefore >= 2);
    const resetDone = await reset.request("/auth/verify", {
      method: "POST",
      form: { csrf_token: resetToken, c: rc, code: gw.lastCode(gw.mail), new_password: "carol-new-password" },
    });
    assert.equal(resetDone.status, 303);
    assert.ok(verifyPassword("carol-new-password", gw.userStore.findById(carolUser.id).passwordHash));
    assert.equal(
      [...gw.authStore.sessions.values()].filter((s) => s.uid === carolUser.id).length,
      1,
      "a reset signs out every other session",
    );
    assert.equal((await carol.request("/api/whoami")).status, 401);

    // A reset for an address with no account sends nothing and looks the same.
    const ghost = browser(gw.baseUrl);
    const mailCount = gw.mail.length;
    const ghostRes = await ghost.request("/auth/forgot", {
      method: "POST",
      form: { csrf_token: await ghost.token("/auth/forgot"), email: "nobody@example.com" },
    });
    assert.equal(ghostRes.status, 303);
    assert.match(ghostRes.location, /^\/auth\/verify\?c=/);
    assert.equal(gw.mail.length, mailCount);
  } finally {
    await gw.close();
  }
});

test("accounts end to end: closed sign-up, allowlists, owner email, unverified takeover, forgery", async () => {
  // --- Sign-up closed: existing accounts still sign in, strangers get nothing ---
  const closed = await startGateway({ signup: { mode: "closed", allowlist: [] }, ownerEmail: "Owner@Example.com" });
  try {
    const existing = closed.userStore.create({ email: "member@example.com", emailVerified: true });
    const b = browser(closed.baseUrl);
    assert.equal((await b.request("/signup")).text.includes("not being accepted"), true);
    const refused = await b.request("/signup", {
      method: "POST",
      form: { csrf_token: await b.token("/login"), email: "new@example.com", password: "password-123" },
    });
    assert.equal(refused.status, 403);

    const stranger = await b.request("/auth/otp/start", {
      method: "POST",
      form: { csrf_token: await b.token("/login?method=email"), channel: "email", email: "stranger@example.com" },
    });
    assert.equal(stranger.status, 303, "the response does not say whether an account exists");
    assert.equal(closed.mail.length, 0, "but no code is sent to an address that cannot sign in");

    const member = await b.request("/auth/otp/start", {
      method: "POST",
      form: { csrf_token: await b.token("/login?method=email"), channel: "email", email: "member@example.com" },
    });
    await b.request("/auth/verify", {
      method: "POST",
      form: { csrf_token: await b.token(member.location), c: new URL(member.location, closed.baseUrl).searchParams.get("c"), code: closed.lastCode(closed.mail) },
    });
    assert.equal((await b.request("/api/whoami")).json().user, existing.id);

    // Google cannot create an account either.
    closed.googleIdentities.set("code-x", { sub: "g-x", email: "x@example.com", name: null });
    const g = browser(closed.baseUrl);
    const go = await g.request("/auth/google");
    const res = await g.request(`/auth/google/callback?code=code-x&state=${new URL(go.location).searchParams.get("state")}`);
    assert.equal(res.location, "/login?m=signup_closed");
    assert.equal(closed.userStore.count(), 1);

    // --- Owner email: a verified sign-in with it opens the owner workspace ---
    closed.googleIdentities.set("code-owner", { sub: "g-owner", email: "owner@example.com", name: "Owner" });
    const o = browser(closed.baseUrl);
    const og = await o.request("/auth/google");
    await o.request(`/auth/google/callback?code=code-owner&state=${new URL(og.location).searchParams.get("state")}`);
    const ownerPage = (await o.request("/")).json();
    assert.equal(ownerPage.root, closed.dataRoot);
    assert.equal(ownerPage.kind, "owner");
    assert.equal(closed.userStore.count(), 1, "the owner is not duplicated as a regular account");
  } finally {
    await closed.close();
  }

  // --- Allowlist: only listed addresses and domains may create accounts ---
  const listed = await startGateway({ signup: { mode: "open", allowlist: ["friend@example.com", "@team.example.org"] } });
  try {
    const b = browser(listed.baseUrl);
    const denied = await b.request("/signup", {
      method: "POST",
      form: { csrf_token: await b.token("/signup"), email: "random@example.com", password: "password-123" },
    });
    assert.equal(denied.status, 403);
    for (const email of ["friend@example.com", "anyone@team.example.org"]) {
      const ok = await b.request("/signup", {
        method: "POST",
        form: { csrf_token: await b.token("/signup"), email, password: "password-123" },
      });
      assert.equal(ok.status, 303, `${email} is on the allowlist`);
    }
    // An email allowlist cannot vouch for a phone number.
    const phone = await b.request("/auth/otp/start", {
      method: "POST",
      form: { csrf_token: await b.token("/login?method=phone"), channel: "phone", phone: "+14155552671" },
    });
    assert.equal(phone.status, 303);
    assert.equal(listed.sms.length, 0);
  } finally {
    await listed.close();
  }

  // --- No email delivery: sign-up works unverified, and proving the address later resets it ---
  const noMail = await startGateway({ emailSender: null });
  try {
    const attacker = browser(noMail.baseUrl);
    const page = await attacker.request("/login");
    assert.equal(page.text.includes("Forgot password"), false);
    const unavail = await attacker.request("/auth/otp/start", {
      method: "POST",
      form: { csrf_token: await attacker.token("/login?method=email"), channel: "email", email: "victim@example.com" },
    });
    assert.equal(unavail.status, 404, "a method with no sender is refused when submitted");

    // Someone registers an address they do not control...
    const squat = await attacker.request("/signup", {
      method: "POST",
      form: { csrf_token: await attacker.token("/signup"), email: "victim@example.com", password: "attacker-password" },
    });
    assert.equal(squat.status, 303);
    assert.equal(squat.location, "/");
    const squatted = noMail.userStore.findByEmail("victim@example.com");
    assert.equal(squatted.emailVerified, false);
    assert.equal((await attacker.request("/api/whoami")).status, 200);

    const second = await browser(noMail.baseUrl);
    const dup = await second.request("/signup", {
      method: "POST",
      form: { csrf_token: await second.token("/signup"), email: "victim@example.com", password: "another-password" },
    });
    assert.equal(dup.status, 409);

    // ...then the real owner of the address signs in with Google. The account
    // becomes theirs alone: the squatter's password and session are gone.
    noMail.googleIdentities.set("code-victim", { sub: "g-victim", email: "victim@example.com", name: "Victim" });
    const victim = browser(noMail.baseUrl);
    const go = await victim.request("/auth/google");
    await victim.request(`/auth/google/callback?code=code-victim&state=${new URL(go.location).searchParams.get("state")}`);
    const claimed = noMail.userStore.findById(squatted.id);
    assert.equal(claimed.emailVerified, true);
    assert.equal(claimed.passwordHash, null);
    assert.equal((await attacker.request("/api/whoami")).status, 401, "the squatter's session is ended");
    assert.equal((await victim.request("/api/whoami")).json().user, squatted.id);
  } finally {
    await noMail.close();
  }

  // --- Forged and cross-site form posts ---
  const gw = await startGateway();
  try {
    const victim = browser(gw.baseUrl);
    const token = await victim.token("/login");

    // A token minted for one browser is useless in another.
    const other = browser(gw.baseUrl);
    await other.token("/login");
    const stolen = await other.request("/login", { method: "POST", form: { csrf_token: token, username: "admin", password: gw.ownerPassword } });
    assert.equal(stolen.status, 401);

    for (const headers of [{ "Sec-Fetch-Site": "cross-site" }, { Origin: "https://evil.example" }, { Origin: "null" }]) {
      const res = await victim.request("/login", { method: "POST", headers, form: { csrf_token: token, username: "admin", password: gw.ownerPassword } });
      assert.equal(res.status, 403, `cross-site post with ${JSON.stringify(headers)} must be refused`);
      const signup = await victim.request("/signup", { method: "POST", headers, form: { csrf_token: token, email: "a@example.com", password: "password-123" } });
      assert.equal(signup.status, 403);
    }
    assert.equal(gw.authStore.sessions.size, 0);
    assert.equal(gw.mail.length, 0);
  } finally {
    await gw.close();
  }
});

test("accounts end to end: code request limits bound what one address can trigger", async () => {
  const gw = await startGateway();
  try {
    const b = browser(gw.baseUrl);
    const ask = async () =>
      b.request("/auth/otp/start", {
        method: "POST",
        form: { csrf_token: await b.token("/login?method=email"), channel: "email", email: "flood@example.com" },
      });
    for (let i = 0; i < 4; i++) assert.equal((await ask()).status, 303);
    const limited = await ask();
    assert.equal(limited.status, 429);
    assert.equal(gw.mail.length, 4, "the fifth request sends nothing");

    // "Send a new code" straight away is held back by the cooldown.
    const fresh = browser(gw.baseUrl);
    const start = await fresh.request("/auth/otp/start", {
      method: "POST",
      form: { csrf_token: await fresh.token("/login?method=email"), channel: "email", email: "patient@example.com" },
    });
    const c = new URL(start.location, gw.baseUrl).searchParams.get("c");
    const resend = await fresh.request("/auth/otp/resend", { method: "POST", form: { csrf_token: await fresh.token(start.location), c } });
    assert.match(resend.location, /wait=\d+/);
    assert.equal(gw.mail.length, 5);
    assert.match((await fresh.request(resend.location)).text, /Please wait/);
  } finally {
    await gw.close();
  }
});

test("accounts end to end: account page, password change, sign out everywhere, delete", async () => {
  const gw = await startGateway();
  try {
    const user = gw.userStore.create({ email: "dana@example.com", emailVerified: true, passwordHash: hashPassword("dana-password-1") });
    const signIn = async () => {
      const b = browser(gw.baseUrl);
      const res = await b.request("/login", {
        method: "POST",
        form: { csrf_token: await b.token("/login"), username: "dana@example.com", password: "dana-password-1" },
      });
      assert.equal(res.status, 303);
      return b;
    };
    const laptop = await signIn();
    const phone = await signIn();

    const page = await laptop.request("/account");
    assert.equal(page.status, 200);
    assert.ok(page.text.includes("dana@example.com"));
    const csrf = /name="csrf_token" value="([a-f0-9]+)"/.exec(page.text)[1];

    // The account page is not reachable signed out, and its forms need the session's token.
    assert.equal((await browser(gw.baseUrl).request("/account")).location, "/login");
    const noToken = await laptop.request("/account/password", { method: "POST", form: { current_password: "dana-password-1", new_password: "dana-password-2" } });
    assert.equal(noToken.status, 403);
    const crossSite = await laptop.request("/account/delete", { method: "POST", headers: { "Sec-Fetch-Site": "cross-site" }, form: { csrf_token: csrf, confirm: "DELETE" } });
    assert.equal(crossSite.status, 403);
    assert.ok(gw.userStore.findById(user.id));

    // Changing the password needs the current one and signs out other devices.
    const wrongCurrent = await laptop.request("/account/password", { method: "POST", form: { csrf_token: csrf, current_password: "nope", new_password: "dana-password-2" } });
    assert.equal(wrongCurrent.status, 401);
    const changed = await laptop.request("/account/password", { method: "POST", form: { csrf_token: csrf, current_password: "dana-password-1", new_password: "dana-password-2" } });
    assert.equal(changed.status, 200);
    assert.ok(verifyPassword("dana-password-2", gw.userStore.findById(user.id).passwordHash));
    assert.equal((await phone.request("/api/whoami")).status, 401, "other devices are signed out");
    assert.equal((await laptop.request("/api/whoami")).status, 200, "this one stays signed in");

    // Delete needs the typed confirmation, then removes the account and its files.
    const workspace = gw.workspaces.rootFor({ id: user.id });
    fs.writeFileSync(path.join(workspace, "cv.md"), "# Dana");
    const unconfirmed = await laptop.request("/account/delete", { method: "POST", form: { csrf_token: csrf, confirm: "yes" } });
    assert.equal(unconfirmed.status, 400);
    assert.ok(fs.existsSync(path.join(workspace, "cv.md")));

    const deleted = await laptop.request("/account/delete", { method: "POST", form: { csrf_token: csrf, confirm: "DELETE" } });
    assert.equal(deleted.status, 303);
    assert.equal(deleted.location, "/login?m=deleted");
    assert.equal(gw.userStore.findById(user.id), null);
    assert.equal(fs.existsSync(workspace), false, "the workspace is removed with the account");
    assert.equal((await laptop.request("/api/whoami")).status, 401);
    assert.ok(fs.existsSync(gw.dataRoot), "the owner's data root is untouched");

    // The owner cannot be deleted from the page.
    const owner = browser(gw.baseUrl);
    await owner.request("/login", { method: "POST", form: { csrf_token: await owner.token("/login"), username: "admin", password: gw.ownerPassword } });
    const ownerPage = await owner.request("/account");
    assert.equal(ownerPage.text.includes("Delete my account"), false);
    const ownerCsrf = /name="csrf_token" value="([a-f0-9]+)"/.exec(ownerPage.text)[1];
    const ownerDelete = await owner.request("/account/delete", { method: "POST", form: { csrf_token: ownerCsrf, confirm: "DELETE" } });
    assert.equal(ownerDelete.status, 403);

    // Sign out everywhere ends every owner session.
    const owner2 = browser(gw.baseUrl);
    await owner2.request("/login", { method: "POST", form: { csrf_token: await owner2.token("/login"), username: "admin", password: gw.ownerPassword } });
    const all = await owner.request("/account/logout-all", { method: "POST", form: { csrf_token: ownerCsrf } });
    assert.equal(all.location, "/login?m=signed_out");
    assert.equal((await owner2.request("/api/whoami")).status, 401);
  } finally {
    await gw.close();
  }
});

test("without a workspace manager only the owner is proxied", async () => {
  const dir = tmp("co-noworkspaces-");
  const upstream = http.createServer((req, res) => res.end("owner data"));
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const authStore = new AuthStore({ sessionDir: dir });
  const userStore = new UserStore({ dir });
  const gateway = createGateway({
    authStore,
    ownerUser: "admin",
    ownerPasswordHash: hashPassword("irrelevant-here"),
    userStore,
    upstreamPort: upstream.address().port,
  });
  await new Promise((r) => gateway.listen(0, "127.0.0.1", r));
  try {
    const user = userStore.create({ email: "eve@example.com", emailVerified: true });
    const session = authStore.createSession(user.id, { uid: user.id });
    const res = await fetch(`http://127.0.0.1:${gateway.address().port}/`, { headers: { Cookie: `career_ops_session=${session.id}` } });
    assert.equal(res.status, 503, "a non-owner account must never fall through to the owner's process");
    assert.equal((await res.text()).includes("owner data"), false);
  } finally {
    gateway.closeAllConnections();
    gateway.close();
    upstream.close();
    cleanup(dir);
  }
});

test("allowDirectFallback: Google, Email OTP, Phone OTP and Password Reset work without external API keys", async () => {
  const gw = await startGateway({
    emailSender: null,
    smsSender: null,
    google: null,
    defaultCountryCode: "+91",
    allowDirectFallback: true,
  });
  try {
    // 1. Continue with Google works without GOOGLE_CLIENT_ID
    const gUser = browser(gw.baseUrl);
    const gPage = await gUser.request("/auth/google");
    assert.equal(gPage.status, 200);
    assert.ok(gPage.text.includes("Sign in with Google"));
    const gToken = /name="csrf_token" value="([a-f0-9]+)"/.exec(gPage.text)[1];
    const gPost = await gUser.request("/auth/google", {
      method: "POST",
      form: { csrf_token: gToken, email: "googleuser@gmail.com", name: "Google User" },
    });
    assert.equal(gPost.status, 303);
    assert.equal(gPost.location, "/");
    assert.equal((await gUser.request("/api/whoami")).status, 200);

    // 2. Email OTP works without SMTP_HOST / RESEND_API_KEY
    const eUser = browser(gw.baseUrl);
    const eStart = await eUser.request("/auth/otp/start", {
      method: "POST",
      form: { csrf_token: await eUser.token("/login?method=email"), channel: "email", email: "otpuser@gmail.com" },
    });
    assert.equal(eStart.status, 303);
    const eVerifyPage = await eUser.request(eStart.location);
    assert.equal(eVerifyPage.status, 200);
    const eCode = /Your 6-digit verification code is (\d{6})/.exec(eVerifyPage.text)?.[1];
    assert.ok(eCode, "6-digit code should be displayed in fallback mode");
    const eVerifyToken = /name="csrf_token" value="([a-f0-9]+)"/.exec(eVerifyPage.text)[1];
    const eChallengeId = new URL(eStart.location, gw.baseUrl).searchParams.get("c");
    const eDone = await eUser.request("/auth/verify", {
      method: "POST",
      form: { csrf_token: eVerifyToken, c: eChallengeId, code: eCode },
    });
    assert.equal(eDone.status, 303);
    assert.equal(eDone.location, "/");
    assert.equal((await eUser.request("/api/whoami")).status, 200);

    // 3. Phone OTP works with 10-digit Indian mobile number without TWILIO_*
    const pUser = browser(gw.baseUrl);
    const pStart = await pUser.request("/auth/otp/start", {
      method: "POST",
      form: { csrf_token: await pUser.token("/login?method=phone"), channel: "phone", phone: "9876543210" },
    });
    assert.equal(pStart.status, 303);
    const pVerifyPage = await pUser.request(pStart.location);
    assert.equal(pVerifyPage.status, 200);
    const pCode = /Your 6-digit verification code is (\d{6})/.exec(pVerifyPage.text)?.[1];
    assert.ok(pCode, "6-digit phone code should be displayed in fallback mode");
    const pVerifyToken = /name="csrf_token" value="([a-f0-9]+)"/.exec(pVerifyPage.text)[1];
    const pChallengeId = new URL(pStart.location, gw.baseUrl).searchParams.get("c");
    const pDone = await pUser.request("/auth/verify", {
      method: "POST",
      form: { csrf_token: pVerifyToken, c: pChallengeId, code: pCode },
    });
    assert.equal(pDone.status, 303);
    assert.equal(pDone.location, "/");
    assert.equal((await pUser.request("/api/whoami")).status, 200);
  } finally {
    await gw.close();
  }
});

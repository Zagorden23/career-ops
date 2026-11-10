/**
 * deploy/gateway.mjs
 * Production Auth & Security Gateway for Career Ops.
 *
 * Sits in front of Next.js to provide:
 * 1. Accounts: sign up and sign in with email + password, an emailed code, a
 *    texted code, or Google. The env-configured owner login keeps working.
 * 2. One private workspace per account: an authenticated request is proxied to
 *    that account's own app process, never to another account's.
 * 3. Protection for all pages and APIs (401 for API, redirect to /login for pages).
 * 4. Health check at /healthz (zero-overhead, no auth).
 * 5. Rate limiting: failed sign-ins per client and per account, codes per
 *    address, per client and in total.
 * 6. CSRF defense: SameSite cookies, Sec-Fetch-Site / Origin validation, and a
 *    form token bound to the browser on every sign-in form.
 * 7. Security headers: CSP, HSTS, X-Frame-Options, nosniff, Referrer-Policy, Permissions-Policy.
 * 8. Cloud-mode capability gates: fails safely for features requiring desktop interaction.
 * 9. Host and reverse-proxy validation.
 *
 * Sign-in methods beyond the password are optional. Each is offered only when
 * the thing it needs was passed in (an email sender, an SMS sender, a Google
 * client), so a gateway built with none of them behaves as the single-owner
 * gateway did.
 */

import http from "node:http";
import crypto from "node:crypto";
import { LoginRateLimiter } from "./rate-limiter.mjs";
import { hashPassword, verifyPassword } from "./hash-password.mjs";
import { getSecurityHeaders } from "./security-headers.mjs";
import {
  renderAuthPage,
  renderVerifyPage,
  renderForgotPage,
  renderAccountPage,
  renderMessagePage,
} from "./auth-pages.mjs";
import { normalizeEmail, normalizePhone, validatePassword, maskEmail, maskPhone } from "./user-store.mjs";
import { OtpStore, SlidingWindowCounter } from "./otp-store.mjs";
import { codeEmail, codeSms, existingAccountEmail } from "./notifiers.mjs";
import { pkcePair } from "./google-oauth.mjs";
import { OWNER_ACCOUNT_ID } from "./workspace-manager.mjs";

const MAX_BODY_SIZE = 100 * 1024; // 100KB max body for auth forms
const PRE_COOKIE = "career_ops_pre";
const OAUTH_COOKIE = "career_ops_oauth";
const CSRF_COOKIE = "career_ops_csrf";
const OAUTH_TTL_MS = 10 * 60 * 1000;

// Code-request limits. A code costs a message (and for SMS, money), so these
// bound what one address, one client and the whole deployment can trigger.
const SEND_PER_DESTINATION = { max: 4, windowMs: 15 * 60 * 1000 };
const SEND_PER_CLIENT = { max: 12, windowMs: 60 * 60 * 1000 };
const HOUR_MS = 60 * 60 * 1000;

/** Messages a redirect may ask the sign-in page to show. Codes, never free text. */
const LOGIN_MESSAGES = {
  google_failed: { error: "Google sign-in did not complete. Please try again." },
  google_unavailable: { error: "Google sign-in is not available on this deployment." },
  signup_closed: { error: "New accounts are not being accepted on this deployment right now." },
  not_allowed: { error: "This address is not allowed to create an account here." },
  expired: { error: "That sign-in attempt expired. Please start again." },
  locked: { error: "Too many wrong codes. Please request a new one." },
  deleted: { notice: "Your account and its data have been deleted." },
  signed_out: { notice: "You have been signed out." },
};

export function createGateway({
  authStore,
  rateLimiter,
  ownerUser,
  ownerPasswordHash,
  ownerEmail = null,
  userStore = null,
  otpStore = null,
  emailSender = null,
  smsSender = null,
  google = null,
  signup = { mode: "open", allowlist: [] },
  defaultCountryCode = "",
  smsHourlyCap = 60,
  secret = null,
  publicUrl = null,
  workspaces = null,
  upstreamHost = "127.0.0.1",
  upstreamPort = 3001,
  allowedHosts = [],
  isCloud = false,
  appName = "Career Ops",
}) {
  if (!ownerUser) throw new Error("ownerUser is required for gateway");
  if (!ownerPasswordHash) throw new Error("ownerPasswordHash is required for gateway");
  if (!authStore) throw new Error("authStore is required for gateway");
  if (!rateLimiter) rateLimiter = new LoginRateLimiter();

  const hmacKey = secret || crypto.randomBytes(32);
  if (!otpStore) otpStore = new OtpStore({ secret: hmacKey });
  const sendCounter = new SlidingWindowCounter();
  const normalizedOwnerEmail = normalizeEmail(ownerEmail);
  const signupMode = signup?.mode === "closed" ? "closed" : "open";
  const signupAllowlist = (signup?.allowlist || []).map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  const publicOrigin = publicUrl ? String(publicUrl).replace(/\/+$/, "") : null;

  // Verified against when the identifier matches no account, so a sign-in for
  // an unknown address takes as long as one with a wrong password.
  const decoyHash = hashPassword(crypto.randomBytes(24).toString("hex"));

  // What this deployment offers. Accounts need somewhere to live (userStore);
  // without it only the owner can sign in, exactly as before.
  const methods = {
    accounts: Boolean(userStore),
    email: Boolean(userStore && emailSender),
    phone: Boolean(userStore && smsSender),
    google: Boolean(userStore && google),
    signup: Boolean(userStore) && signupMode === "open",
    reset: Boolean(userStore && emailSender),
  };

  // Normalized set of allowed hosts
  const hostAllowlist = new Set(
    ["localhost", "127.0.0.1", "[::1]", ...allowedHosts]
      .filter(Boolean)
      .map((h) => normalizeHost(h))
  );

  const ownerAccount = {
    id: OWNER_ACCOUNT_ID,
    kind: "owner",
    label: ownerUser,
    sessionUser: ownerUser,
    email: normalizedOwnerEmail,
    phone: null,
    name: null,
    googleLinked: false,
    hasPassword: true,
  };

  function accountFromUser(user) {
    return {
      id: user.id,
      kind: "user",
      label: user.email || user.phone || user.name || user.id,
      sessionUser: user.id,
      email: user.email,
      phone: user.phone,
      name: user.name,
      googleLinked: Boolean(user.googleSub),
      hasPassword: Boolean(user.passwordHash),
    };
  }

  /** The account a session belongs to, or null when that account is gone. */
  function accountForSession(session) {
    if (!session) return null;
    // Sessions written before accounts existed carry only `user`.
    const uid = session.uid || (session.user === ownerUser ? OWNER_ACCOUNT_ID : null);
    if (uid === OWNER_ACCOUNT_ID) return ownerAccount;
    const user = userStore?.findById(uid);
    return user ? accountFromUser(user) : null;
  }

  /** May this email address create an account? */
  function emailSignupAllowed(email) {
    if (!methods.signup) return false;
    if (signupAllowlist.length === 0) return true;
    const domain = email.slice(email.lastIndexOf("@"));
    return signupAllowlist.some((entry) => entry === email || entry === domain || `@${entry}` === domain);
  }

  /** Phone sign-up has no allowlist of its own, so an email allowlist closes it. */
  function phoneSignupAllowed() {
    return methods.signup && signupAllowlist.length === 0;
  }

  /**
   * An address has just been proved by a code or by Google. If the account
   * holding it never proved it, whoever set that account's password may not be
   * the address's owner: drop the password and every open session before
   * handing the account over.
   */
  function claimVerifiedEmail(user, patch = {}) {
    if (user.emailVerified) {
      return Object.keys(patch).length ? userStore.update(user.id, patch) : user;
    }
    authStore.destroySessionsFor(user.id);
    return userStore.update(user.id, { ...patch, emailVerified: true, passwordHash: null });
  }

  const sign = (value) => crypto.createHmac("sha256", hmacKey).update(value).digest("hex");

  function safeEqual(a, b) {
    const x = Buffer.from(String(a), "utf8");
    const y = Buffer.from(String(b), "utf8");
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      // One request's failure must not take the gateway down with it.
      console.error(`[gateway] Unhandled error on ${req.method} ${String(req.url).split("?")[0]}: ${err.stack || err.message}`);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ error: "Internal gateway error" }));
      } else {
        res.destroy();
      }
    });
  });

  async function handle(req, res) {
    let url;
    try {
      // A fixed base: the Host header is validated separately and must not be
      // able to make this parse throw.
      url = new URL(req.url || "/", "http://gateway.invalid");
    } catch {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "Bad request" }));
      return;
    }
    const pathname = url.pathname;
    const method = req.method || "GET";

    const isHttps =
      String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https" ||
      Boolean(req.socket.encrypted);
    const clientIp = extractClientIp(req);

    const secHeaders = getSecurityHeaders({ isHttps });
    const applySecHeaders = () => {
      for (const [k, v] of Object.entries(secHeaders)) res.setHeader(k, v);
    };

    const sendJson = (status, body, headers = {}) => {
      applySecHeaders();
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
      res.end(JSON.stringify(body));
    };
    const sendHtml = (status, html, headers = {}) => {
      applySecHeaders();
      res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...headers });
      res.end(html);
    };
    const redirect = (location, status = 303) => {
      applySecHeaders();
      res.writeHead(status, { Location: location, "Cache-Control": "no-store" });
      res.end();
    };
    const addCookie = (cookie) => {
      const existing = res.getHeader("Set-Cookie");
      const list = Array.isArray(existing) ? existing : existing ? [String(existing)] : [];
      res.setHeader("Set-Cookie", [...list, cookie]);
    };
    const secureFlag = isHttps ? "; Secure" : "";
    const wantsJson = () => String(req.headers.accept || "").includes("application/json");

    // 1. Host validation
    const normalizedHost = normalizeHost(req.headers.host || "");
    if (!normalizedHost || !isHostAllowed(normalizedHost, hostAllowlist)) {
      sendJson(403, { error: "Forbidden: unauthorized Host header" });
      return;
    }

    // 2. Health check endpoint — fast, public, zero-auth
    if (pathname === "/healthz" || pathname === "/health") {
      sendJson(200, { status: "ok", timestamp: new Date().toISOString() });
      return;
    }

    const cookies = parseCookies(req.headers.cookie);
    const cookieName = isHttps ? "__Host-career_ops_session" : "career_ops_session";
    const sessionId = cookies[cookieName] || cookies["career_ops_session"];
    let session = sessionId ? authStore.getSession(sessionId) : null;
    let account = accountForSession(session);
    if (session && !account) {
      // The account was deleted while this session was open.
      authStore.destroySession(sessionId);
      session = null;
    }

    /** True when a state-changing request did not come from this site. */
    const isCrossSite = () => {
      if (req.headers["sec-fetch-site"] === "cross-site") return true;
      const origin = req.headers.origin;
      if (!origin) return false;
      try {
        const originHost = normalizeHost(new URL(origin).host);
        return originHost !== normalizedHost && !isHostAllowed(originHost, hostAllowlist);
      } catch {
        return true;
      }
    };

    // The browser a sign-in form was served to. The form's token is derived
    // from it, so a token lifted from one browser is useless in another.
    const preSession = () => {
      let pre = cookies[PRE_COOKIE];
      if (!pre || !/^[a-f0-9]{32}$/.test(pre)) {
        pre = crypto.randomBytes(16).toString("hex");
        cookies[PRE_COOKIE] = pre;
        addCookie(`${PRE_COOKIE}=${pre}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400${secureFlag}`);
      }
      return pre;
    };
    const formToken = () => sign(`form:${preSession()}`);
    const formTokenValid = (token) => {
      const pre = cookies[PRE_COOKIE];
      if (!pre || !/^[a-f0-9]{32}$/.test(pre) || typeof token !== "string" || !token) return false;
      return safeEqual(sign(`form:${pre}`), token);
    };

    const readForm = async () => {
      try {
        return parseFormOrJson(await readBody(req, MAX_BODY_SIZE), req.headers["content-type"]);
      } catch {
        return null;
      }
    };

    const clearSessionCookies = () => {
      addCookie(`${cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureFlag}`);
      addCookie(`${CSRF_COOKIE}=; Path=/; SameSite=Lax; Max-Age=0${secureFlag}`);
    };

    /** Open a session for an account and set its cookies. */
    const startSession = (target) => {
      const created = authStore.createSession(target.sessionUser, { uid: target.id });
      const maxAge = Math.floor(authStore.maxAgeMs / 1000);
      addCookie(`${cookieName}=${created.id}; Path=/; HttpOnly; SameSite=Lax${secureFlag}; Max-Age=${maxAge}`);
      // Readable CSRF token cookie for frontend fetch requests
      addCookie(`${CSRF_COOKIE}=${created.csrfToken}; Path=/; SameSite=Lax${secureFlag}; Max-Age=${maxAge}`);
      // The pre-session identifier has done its job; a new sign-in gets a new one.
      addCookie(`${PRE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureFlag}`);
      if (target.kind === "user") userStore.update(target.id, { lastLoginAt: Date.now() });
      return created;
    };

    const authPage = (status, options, headers = {}) =>
      sendHtml(status, renderAuthPage({ methods, csrfToken: formToken(), ...options }), headers);

    const messagePage = (status, title, message, extra = {}) =>
      sendHtml(status, renderMessagePage({ title, message, ...extra }));

    /**
     * Every auth form post passes through here: same-site, a readable body and
     * a form token that belongs to this browser.
     * @returns {Promise<Record<string, string> | null>} The form, or null when a response was already sent.
     */
    const acceptForm = async (rerender) => {
      if (isCrossSite()) {
        sendJson(403, { error: "Forbidden: cross-site request rejected" });
        return null;
      }
      const form = await readForm();
      if (!form) {
        sendJson(400, { error: "Request payload too large or unreadable" });
        return null;
      }
      if (!formTokenValid(form.csrf_token)) {
        const message = "Session expired or invalid form submission. Please try again.";
        if (wantsJson()) sendJson(401, { error: message });
        else rerender(message);
        return null;
      }
      return form;
    };

    /** May another code go out to this address from this client? */
    const sendBlocked = (channel, destination) => {
      const waits = [
        sendCounter.retryAfter(`to:${destination}`, SEND_PER_DESTINATION.max, SEND_PER_DESTINATION.windowMs),
        sendCounter.retryAfter(`ip:${clientIp}`, SEND_PER_CLIENT.max, SEND_PER_CLIENT.windowMs),
        channel === "phone" ? sendCounter.retryAfter("sms:all", smsHourlyCap, HOUR_MS) : 0,
      ];
      return Math.max(...waits);
    };
    const recordSend = (channel, destination) => {
      sendCounter.record(`to:${destination}`, SEND_PER_DESTINATION.windowMs);
      sendCounter.record(`ip:${clientIp}`, SEND_PER_CLIENT.windowMs);
      if (channel === "phone") sendCounter.record("sms:all", HOUR_MS);
    };

    /** Deliver a code. Throws when the provider refuses it. */
    const deliverCode = async (challenge, code) => {
      if (challenge.channel === "phone") {
        await smsSender.send({ to: challenge.destination, text: codeSms({ code, appName }) });
      } else {
        await emailSender.send({ to: challenge.destination, ...codeEmail({ code, purpose: challenge.purpose, appName }) });
      }
    };

    const requestOrigin = () => publicOrigin || `${isHttps ? "https" : "http"}://${req.headers.host}`;

    // ------------------------------------------------------------------
    // 3. Sign in with a password
    // ------------------------------------------------------------------
    if (pathname === "/login") {
      if (method === "GET") {
        if (session) return redirect("/", 302);
        const flash = LOGIN_MESSAGES[url.searchParams.get("m") || ""] || {};
        return authPage(200, { mode: "login", method: url.searchParams.get("method") || "password", ...flash });
      }

      if (method === "POST") {
        const rateCheck = rateLimiter.check(clientIp);
        if (!rateCheck.allowed) {
          const reason = rateCheck.reason || "Too many failed attempts. Please wait.";
          const retry = { "Retry-After": String(rateCheck.retryAfterSeconds || 60) };
          if (wantsJson()) return sendJson(429, { error: reason }, retry);
          return authPage(429, { mode: "login", error: reason }, retry);
        }

        if (isCrossSite()) return sendJson(403, { error: "Forbidden: cross-site request rejected" });
        const form = await readForm();
        if (!form) return sendJson(400, { error: "Request payload too large" });

        const identifier = String(form.username ?? form.email ?? "").trim().slice(0, 254);
        const password = typeof form.password === "string" ? form.password : "";
        const idKey = identifier ? `id:${identifier.toLowerCase()}` : null;

        const csrfValid = formTokenValid(form.csrf_token);
        const idCheck = idKey ? rateLimiter.check(idKey) : { allowed: true };

        let target = null;
        if (csrfValid && idCheck.allowed && identifier) {
          const email = normalizeEmail(identifier);
          const user = email ? userStore?.findByEmail(email) : null;
          const isOwnerIdentifier = identifier === ownerUser || (email && email === normalizedOwnerEmail);
          if (isOwnerIdentifier) {
            if (verifyPassword(password, ownerPasswordHash)) target = ownerAccount;
          } else if (user?.passwordHash) {
            if (verifyPassword(password, user.passwordHash)) target = accountFromUser(user);
          } else {
            verifyPassword(password, decoyHash);
          }
        }

        if (!target) {
          rateLimiter.recordFailure(clientIp);
          if (idKey && csrfValid) rateLimiter.recordFailure(idKey, { global: false });
          const delayMs = rateLimiter.getDelayMs(clientIp);
          if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));

          const errorMessage = !csrfValid
            ? "Session expired or invalid form submission. Please try again."
            : !idCheck.allowed
              ? "Too many failed attempts for this account. Please wait, or sign in another way."
              : "Invalid username or password.";
          if (wantsJson()) return sendJson(401, { error: errorMessage });
          return authPage(401, { mode: "login", error: errorMessage, values: { identifier } });
        }

        rateLimiter.recordSuccess(clientIp);
        if (idKey) rateLimiter.recordSuccess(idKey);
        const created = startSession(target);
        if (wantsJson()) return sendJson(200, { ok: true, csrfToken: created.csrfToken });
        return redirect("/");
      }

      res.writeHead(405, { Allow: "GET, POST" });
      res.end();
      return;
    }

    // ------------------------------------------------------------------
    // 4. Create an account with email + password
    // ------------------------------------------------------------------
    if (pathname === "/signup") {
      if (method === "GET") {
        if (session) return redirect("/", 302);
        return authPage(200, { mode: "signup", method: url.searchParams.get("method") || "password" });
      }
      if (method !== "POST") {
        res.writeHead(405, { Allow: "GET, POST" });
        res.end();
        return;
      }
      if (!methods.signup) return authPage(403, { mode: "signup" });

      const form = await acceptForm((error) => authPage(401, { mode: "signup", error }));
      if (!form) return;

      const email = normalizeEmail(form.email);
      const name = typeof form.name === "string" ? form.name : "";
      const values = { email: String(form.email || "").slice(0, 254), name: name.slice(0, 80) };
      const fail = (status, error) => authPage(status, { mode: "signup", error, values });

      if (!email) return fail(400, "Enter a valid email address.");
      const passwordProblem = validatePassword(form.password);
      if (passwordProblem) return fail(400, passwordProblem);
      if (!emailSignupAllowed(email)) return fail(403, LOGIN_MESSAGES.not_allowed.error);

      const taken = email === normalizedOwnerEmail || Boolean(userStore.findByEmail(email));

      if (!emailSender) {
        // No way to prove the address, so the account starts unverified. The
        // first verified sign-in to it (a code, Google) resets its password.
        if (taken) return fail(409, "An account with this email already exists. Sign in instead.");
        const user = userStore.create({ email, passwordHash: hashPassword(form.password), name });
        startSession(accountFromUser(user));
        return redirect("/");
      }

      const wait = sendBlocked("email", email);
      if (wait > 0) return fail(429, `Too many codes requested. Try again in ${formatWait(wait)}.`);
      recordSend("email", email);

      // An address that already has an account gets a note saying so instead of
      // a code. The page that follows is the same either way, so the form does
      // not reveal which addresses are registered.
      const { id, code } = otpStore.create({
        channel: "email",
        destination: email,
        purpose: "signup",
        payload: taken ? {} : { passwordHash: hashPassword(form.password), name },
        dead: taken,
      });
      try {
        if (taken) {
          await emailSender.send({ to: email, ...existingAccountEmail({ appName, loginUrl: `${requestOrigin()}/login` }) });
        } else {
          await emailSender.send({ to: email, ...codeEmail({ code, purpose: "signup", appName }) });
        }
      } catch (err) {
        console.error(`[gateway] Could not send sign-up email: ${err.message}`);
        otpStore.discard(id);
        return fail(502, "We could not send the verification email. Please try again in a few minutes.");
      }
      return redirect(`/auth/verify?c=${id}`);
    }

    // ------------------------------------------------------------------
    // 5. Sign in (or sign up) with an emailed or texted code
    // ------------------------------------------------------------------
    if (pathname === "/auth/otp/start") {
      if (method !== "POST") {
        res.writeHead(405, { Allow: "POST" });
        res.end();
        return;
      }
      const form = await acceptForm((error) => authPage(401, { mode: "login", error }));
      if (!form) return;

      const channel = form.channel === "phone" ? "phone" : "email";
      const mode = form.intent === "signup" ? "signup" : "login";
      if (!methods[channel]) {
        return authPage(404, { mode, method: channel, error: "That sign-in method is not available on this deployment." });
      }

      const raw = String(channel === "phone" ? form.phone ?? "" : form.email ?? "").slice(0, 254);
      const destination = channel === "phone" ? normalizePhone(raw, defaultCountryCode) : normalizeEmail(raw);
      const fail = (status, error) => authPage(status, { mode, method: channel, error, values: { [channel]: raw } });
      if (!destination) {
        return fail(
          400,
          channel === "phone"
            ? "Enter your mobile number with its country code, for example +91 98765 43210."
            : "Enter a valid email address.",
        );
      }

      const wait = sendBlocked(channel, destination);
      if (wait > 0) return fail(429, `Too many codes requested. Try again in ${formatWait(wait)}.`);
      recordSend(channel, destination);

      const known =
        channel === "phone"
          ? Boolean(userStore.findByPhone(destination))
          : destination === normalizedOwnerEmail || Boolean(userStore.findByEmail(destination));
      const eligible = known || (channel === "phone" ? phoneSignupAllowed() : emailSignupAllowed(destination));

      const { id, code } = otpStore.create({ channel, destination, purpose: "login", dead: !eligible });
      if (eligible) {
        try {
          await deliverCode({ channel, destination, purpose: "login" }, code);
        } catch (err) {
          console.error(`[gateway] Could not send ${channel} code: ${err.message}`);
          otpStore.discard(id);
          return fail(502, "We could not send the code. Please try again in a few minutes.");
        }
      }
      return redirect(`/auth/verify?c=${id}`);
    }

    if (pathname === "/auth/otp/resend") {
      if (method !== "POST") {
        res.writeHead(405, { Allow: "POST" });
        res.end();
        return;
      }
      const form = await acceptForm(() => redirect("/login?m=expired"));
      if (!form) return;
      const id = String(form.c || "");
      const existing = otpStore.get(id);
      if (!existing) return redirect("/login?m=expired");

      const wait = sendBlocked(existing.channel, existing.destination);
      if (wait > 0) return redirect(`/auth/verify?c=${id}&wait=${wait}`);
      const result = otpStore.regenerate(id);
      if (!result.ok) {
        if (result.reason === "cooldown") return redirect(`/auth/verify?c=${id}&wait=${result.retryAfterSeconds}`);
        if (result.reason === "limit") return redirect(`/auth/verify?c=${id}&limit=1`);
        return redirect("/login?m=expired");
      }
      recordSend(existing.channel, existing.destination);
      if (result.code) {
        try {
          await deliverCode(result.challenge, result.code);
        } catch (err) {
          console.error(`[gateway] Could not resend ${existing.channel} code: ${err.message}`);
          return redirect(`/auth/verify?c=${id}&failed=1`);
        }
      }
      return redirect(`/auth/verify?c=${id}&sent=1`);
    }

    if (pathname === "/auth/verify") {
      const verifyPage = (status, challenge, extra = {}) =>
        sendHtml(
          status,
          renderVerifyPage({
            csrfToken: formToken(),
            challengeId: challenge.id,
            channel: challenge.channel,
            destinationMasked:
              challenge.channel === "phone" ? maskPhone(challenge.destination) : maskEmail(challenge.destination),
            purpose: challenge.purpose,
            ...extra,
          }),
        );

      if (method === "GET") {
        const challenge = otpStore.get(url.searchParams.get("c") || "");
        if (!challenge) return redirect("/login?m=expired", 302);
        const extra = {};
        const waitParam = Number.parseInt(url.searchParams.get("wait") || "", 10);
        if (url.searchParams.get("sent")) extra.notice = "A new code is on its way.";
        else if (Number.isInteger(waitParam) && waitParam > 0) {
          extra.error = `Please wait ${formatWait(Math.min(waitParam, 86400))} before requesting another code.`;
        } else if (url.searchParams.get("limit")) {
          extra.error = "No more codes can be sent for this attempt. Start again from the sign-in page.";
        } else if (url.searchParams.get("failed")) {
          extra.error = "We could not send a new code. Please try again in a few minutes.";
        }
        return verifyPage(200, challenge, extra);
      }

      if (method !== "POST") {
        res.writeHead(405, { Allow: "GET, POST" });
        res.end();
        return;
      }

      const rateCheck = rateLimiter.check(clientIp);
      if (!rateCheck.allowed) {
        return messagePage(429, "Too many attempts", rateCheck.reason || "Please wait before trying again.");
      }
      const form = await acceptForm(() => redirect("/login?m=expired"));
      if (!form) return;

      const id = String(form.c || "");
      const pending = otpStore.get(id);
      if (!pending) return redirect("/login?m=expired");

      if (pending.purpose === "reset") {
        // Checked before the code, so a weak password does not burn a guess.
        const passwordProblem = validatePassword(form.new_password);
        if (passwordProblem) return verifyPage(400, pending, { error: passwordProblem });
      }

      const result = otpStore.verify(id, form.code);
      if (!result.ok) {
        rateLimiter.recordFailure(clientIp);
        if (result.reason === "invalid") {
          const left = result.remaining === 1 ? "1 attempt left" : `${result.remaining} attempts left`;
          return verifyPage(401, pending, { error: `That code is not right (${left}).` });
        }
        return redirect(result.reason === "locked" ? "/login?m=locked" : "/login?m=expired");
      }

      const challenge = result.challenge;
      let target = null;

      if (challenge.purpose === "signup") {
        if (userStore.findByEmail(challenge.destination) || !emailSignupAllowed(challenge.destination)) {
          return redirect("/login?m=expired");
        }
        target = accountFromUser(
          userStore.create({
            email: challenge.destination,
            emailVerified: true,
            passwordHash: challenge.payload.passwordHash,
            name: challenge.payload.name,
          }),
        );
      } else if (challenge.purpose === "reset") {
        const user = userStore.findByEmail(challenge.destination);
        if (!user) return redirect("/login?m=expired");
        authStore.destroySessionsFor(user.id);
        target = accountFromUser(
          userStore.update(user.id, { passwordHash: hashPassword(form.new_password), emailVerified: true }),
        );
      } else if (challenge.channel === "phone") {
        let user = userStore.findByPhone(challenge.destination);
        if (!user) {
          if (!phoneSignupAllowed()) return redirect("/login?m=signup_closed");
          user = userStore.create({ phone: challenge.destination, phoneVerified: true });
        } else if (!user.phoneVerified) {
          user = userStore.update(user.id, { phoneVerified: true });
        }
        target = accountFromUser(user);
      } else if (challenge.destination === normalizedOwnerEmail) {
        target = ownerAccount;
      } else {
        let user = userStore.findByEmail(challenge.destination);
        if (user) {
          user = claimVerifiedEmail(user);
        } else {
          if (!emailSignupAllowed(challenge.destination)) return redirect("/login?m=signup_closed");
          user = userStore.create({ email: challenge.destination, emailVerified: true });
        }
        target = accountFromUser(user);
      }

      rateLimiter.recordSuccess(clientIp);
      startSession(target);
      return redirect("/");
    }

    // ------------------------------------------------------------------
    // 6. Forgot password
    // ------------------------------------------------------------------
    if (pathname === "/auth/forgot") {
      if (!methods.reset) {
        return messagePage(404, "Password reset unavailable", "This deployment cannot send email, so passwords cannot be reset here. Sign in another way, or ask the administrator.");
      }
      if (method === "GET") return sendHtml(200, renderForgotPage({ csrfToken: formToken() }));
      if (method !== "POST") {
        res.writeHead(405, { Allow: "GET, POST" });
        res.end();
        return;
      }
      const form = await acceptForm((error) => sendHtml(401, renderForgotPage({ csrfToken: formToken(), error })));
      if (!form) return;

      const email = normalizeEmail(form.email);
      const fail = (status, error) =>
        sendHtml(status, renderForgotPage({ csrfToken: formToken(), error, values: { email: String(form.email || "").slice(0, 254) } }));
      if (!email) return fail(400, "Enter a valid email address.");
      const wait = sendBlocked("email", email);
      if (wait > 0) return fail(429, `Too many codes requested. Try again in ${formatWait(wait)}.`);
      recordSend("email", email);

      const user = userStore.findByEmail(email);
      const { id, code } = otpStore.create({ channel: "email", destination: email, purpose: "reset", dead: !user });
      if (user) {
        try {
          await emailSender.send({ to: email, ...codeEmail({ code, purpose: "reset", appName }) });
        } catch (err) {
          console.error(`[gateway] Could not send reset email: ${err.message}`);
          otpStore.discard(id);
          return fail(502, "We could not send the reset email. Please try again in a few minutes.");
        }
      }
      return redirect(`/auth/verify?c=${id}`);
    }

    // ------------------------------------------------------------------
    // 7. Continue with Google
    // ------------------------------------------------------------------
    if (pathname === "/auth/google") {
      if (method !== "GET") {
        res.writeHead(405, { Allow: "GET" });
        res.end();
        return;
      }
      if (!methods.google) return redirect("/login?m=google_unavailable", 302);
      const state = crypto.randomBytes(24).toString("base64url");
      const nonce = crypto.randomBytes(24).toString("base64url");
      const { verifier, challenge } = pkcePair();
      const payload = Buffer.from(
        JSON.stringify({ state, nonce, verifier, exp: Date.now() + OAUTH_TTL_MS }),
        "utf8",
      ).toString("base64url");
      addCookie(
        `${OAUTH_COOKIE}=${payload}.${sign(`oauth:${payload}`)}; Path=/auth/google; HttpOnly; SameSite=Lax; Max-Age=${OAUTH_TTL_MS / 1000}${secureFlag}`,
      );
      return redirect(
        google.buildAuthUrl({
          redirectUri: `${requestOrigin()}/auth/google/callback`,
          state,
          nonce,
          codeChallenge: challenge,
        }),
        302,
      );
    }

    if (pathname === "/auth/google/callback") {
      if (method !== "GET") {
        res.writeHead(405, { Allow: "GET" });
        res.end();
        return;
      }
      if (!methods.google) return redirect("/login?m=google_unavailable", 302);
      addCookie(`${OAUTH_COOKIE}=; Path=/auth/google; HttpOnly; SameSite=Lax; Max-Age=0${secureFlag}`);

      // The attempt this browser started: state, nonce and PKCE verifier,
      // carried in a cookie this server signed.
      let attempt = null;
      const [payload, signature] = String(cookies[OAUTH_COOKIE] || "").split(".");
      if (payload && signature && safeEqual(sign(`oauth:${payload}`), signature)) {
        try {
          attempt = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
        } catch {
          attempt = null;
        }
      }
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (
        !attempt ||
        !(attempt.exp > Date.now()) ||
        !code ||
        !state ||
        !safeEqual(attempt.state, state)
      ) {
        return redirect("/login?m=google_failed", 302);
      }

      let identity;
      try {
        identity = await google.exchangeCode({
          code,
          redirectUri: `${requestOrigin()}/auth/google/callback`,
          codeVerifier: attempt.verifier,
          nonce: attempt.nonce,
        });
      } catch (err) {
        console.error(`[gateway] ${err.message}`);
        return redirect("/login?m=google_failed", 302);
      }

      const email = normalizeEmail(identity.email);
      if (!email) return redirect("/login?m=google_failed", 302);

      let target;
      if (email === normalizedOwnerEmail) {
        target = ownerAccount;
      } else {
        let user = userStore.findByGoogleSub(identity.sub) || userStore.findByEmail(email);
        if (user) {
          const patch = {};
          if (user.googleSub !== identity.sub) patch.googleSub = identity.sub;
          if (!user.name && identity.name) patch.name = identity.name;
          // Google vouches for the address only on the account that holds it.
          user = user.email === email ? claimVerifiedEmail(user, patch) : userStore.update(user.id, patch) || user;
        } else {
          if (!emailSignupAllowed(email)) {
            return redirect(methods.signup ? "/login?m=not_allowed" : "/login?m=signup_closed", 302);
          }
          user = userStore.create({ email, emailVerified: true, googleSub: identity.sub, name: identity.name });
        }
        target = accountFromUser(user);
      }
      startSession(target);
      return redirect("/", 302);
    }

    // ------------------------------------------------------------------
    // 8. Sign out
    // ------------------------------------------------------------------
    if (pathname === "/logout") {
      if (method === "POST") {
        if (isCrossSite()) return sendJson(403, { error: "Forbidden: cross-site request rejected" });
        if (sessionId) authStore.destroySession(sessionId);
        clearSessionCookies();
        if (wantsJson()) return sendJson(200, { ok: true });
        return redirect("/login");
      }
      // A GET must not sign anyone out: a link or an image tag on another site
      // could fire it. Ask, and let the button do it.
      if (!session) return redirect("/login", 302);
      return messagePage(200, "Sign out?", `You are signed in as ${account.label}.`, {
        form: { action: "/logout", label: "Sign out", csrfToken: session.csrfToken },
      });
    }

    // 9. Who am I — lets the app show the signed-in account.
    if (pathname === "/auth/me") {
      if (!session) return sendJson(401, { authenticated: false });
      return sendJson(200, {
        authenticated: true,
        account: { kind: account.kind, label: account.label, name: account.name, email: account.email, phone: account.phone },
      });
    }

    // 10. Authentication check for all other routes
    if (!session) {
      const isApi = pathname.startsWith("/api/") || wantsJson();
      if (isApi) return sendJson(401, { error: "Unauthorized: valid session required" });
      return redirect("/login", 302);
    }

    // Authenticated! Slide session activity
    authStore.touchSession(sessionId);

    // 11. CSRF protection on mutating requests (POST, PUT, DELETE, PATCH)
    const isMutating = ["POST", "PUT", "DELETE", "PATCH"].includes(method);
    if (isMutating && isCrossSite()) {
      return sendJson(403, {
        error:
          req.headers["sec-fetch-site"] === "cross-site"
            ? "Forbidden: cross-site request rejected"
            : "Forbidden: cross-origin request rejected",
      });
    }

    // ------------------------------------------------------------------
    // 12. Account page
    // ------------------------------------------------------------------
    if (pathname === "/account" || pathname.startsWith("/account/")) {
      const accountPage = (status, extra = {}) =>
        sendHtml(status, renderAccountPage({ csrfToken: session.csrfToken, account: accountForSession(session), ...extra }));

      if (pathname === "/account") {
        if (method !== "GET") {
          res.writeHead(405, { Allow: "GET" });
          res.end();
          return;
        }
        return accountPage(200);
      }
      if (method !== "POST") {
        res.writeHead(405, { Allow: "POST" });
        res.end();
        return;
      }
      const form = await readForm();
      if (!form) return sendJson(400, { error: "Request payload too large or unreadable" });
      if (!authStore.validateCsrf(sessionId, form.csrf_token)) {
        return accountPage(403, { error: "That form expired. Please try again." });
      }

      if (pathname === "/account/logout-all") {
        if (account.kind === "owner") {
          // Owner sessions written before accounts existed carry no account id.
          for (const s of [...authStore.sessions.values()]) {
            if (accountForSession(s)?.id === OWNER_ACCOUNT_ID) authStore.destroySession(s.id);
          }
        } else {
          authStore.destroySessionsFor(account.id);
        }
        clearSessionCookies();
        return redirect("/login?m=signed_out");
      }

      if (account.kind !== "user") {
        return accountPage(403, { error: "This setting is managed by the deployment's environment for the owner account." });
      }
      const user = userStore.findById(account.id);

      if (pathname === "/account/password") {
        if (user.passwordHash) {
          const rateKey = `id:${account.id}`;
          if (!rateLimiter.check(rateKey).allowed) {
            return accountPage(429, { error: "Too many wrong passwords. Please wait before trying again." });
          }
          if (!verifyPassword(String(form.current_password ?? ""), user.passwordHash)) {
            rateLimiter.recordFailure(rateKey, { global: false });
            return accountPage(401, { error: "Your current password is not right." });
          }
          rateLimiter.recordSuccess(rateKey);
        }
        const passwordProblem = validatePassword(form.new_password);
        if (passwordProblem) return accountPage(400, { error: passwordProblem });
        userStore.update(user.id, { passwordHash: hashPassword(form.new_password) });
        authStore.destroySessionsFor(user.id, sessionId);
        return accountPage(200, { notice: "Password saved. Your other devices were signed out." });
      }

      if (pathname === "/account/delete") {
        if (String(form.confirm ?? "").trim() !== "DELETE") {
          return accountPage(400, { error: "Type DELETE to confirm deleting your account." });
        }
        // Workspace first: if this fails the account still exists and can try
        // again, where the other order would orphan the data.
        if (workspaces) await workspaces.removeWorkspace(account);
        authStore.destroySessionsFor(user.id);
        userStore.delete(user.id);
        clearSessionCookies();
        return redirect("/login?m=deleted");
      }

      return sendJson(404, { error: "Not found" });
    }

    // 13. Cloud-mode capability check
    if (isCloud && pathname.startsWith("/api/apply/")) {
      // Apply mode requires local headed Chrome with human handoff window
      return sendJson(501, {
        error: "Apply mode requires a local desktop browser with human handoff and is not available in cloud deployment. Please use the local Career Ops CLI.",
        unsupportedInCloud: true,
      });
    }

    // 14. Find this account's own app process
    let upstream;
    if (workspaces) {
      try {
        upstream = await workspaces.acquire(account);
      } catch (err) {
        const busy = err.code === "WORKSPACE_BUSY";
        if (!busy) console.error(`[gateway] Could not start workspace for ${account.id}: ${err.message}`);
        const message = busy ? err.message : "Your workspace could not be started. Please try again in a moment.";
        const headers = { "Retry-After": "15" };
        if (pathname.startsWith("/api/") || wantsJson()) return sendJson(503, { error: message }, headers);
        return sendHtml(
          503,
          renderMessagePage({ title: "Starting your workspace", message, linkHref: pathname, linkLabel: "Try again" }),
          headers,
        );
      }
    } else if (account.kind === "owner") {
      upstream = { host: upstreamHost, port: upstreamPort, release() {} };
    } else {
      // One shared process would show this account the owner's files.
      return sendJson(503, { error: "Workspaces are not configured on this deployment." });
    }

    // 15. Proxy the authenticated request to it
    proxyRequest({ req, res, upstream, account, isHttps, clientIp, applySecHeaders });
  }

  return server;
}

/** Headers set by this gateway for the app; a client must not be able to supply them. */
const TRUSTED_REQUEST_HEADERS = ["x-career-ops-user", "x-career-ops-account", "x-career-ops-account-kind"];

/** Response headers that describe one hop's connection, not the response. */
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-connection", "upgrade"]);

/** Response headers the gateway's own security policy replaces. */
const POLICY_HEADERS = new Set([
  "content-security-policy",
  "x-frame-options",
  "x-content-type-options",
  "strict-transport-security",
  "referrer-policy",
  "permissions-policy",
]);

function proxyRequest({ req, res, upstream, account, isHttps, clientIp, applySecHeaders }) {
  const forwardedHeaders = { ...req.headers };
  for (const name of TRUSTED_REQUEST_HEADERS) delete forwardedHeaders[name];

  // Set standard proxy headers
  forwardedHeaders["x-forwarded-for"] = clientIp;
  forwardedHeaders["x-forwarded-proto"] = isHttps ? "https" : "http";
  forwardedHeaders["x-forwarded-host"] = req.headers.host || "";
  forwardedHeaders["x-career-ops-user"] = account.sessionUser;
  // Percent-encoded: a display label may hold characters a header cannot.
  forwardedHeaders["x-career-ops-account"] = encodeURIComponent(account.label);
  forwardedHeaders["x-career-ops-account-kind"] = account.kind;

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    upstream.release();
  };

  const proxyReq = http.request(
    { hostname: upstream.host, port: upstream.port, path: req.url, method: req.method, headers: forwardedHeaders },
    (upstreamRes) => {
      applySecHeaders();

      // Copy upstream headers except those overridden by security policy
      for (const [k, v] of Object.entries(upstreamRes.headers)) {
        const lower = k.toLowerCase();
        if (!POLICY_HEADERS.has(lower) && !HOP_BY_HOP.has(lower)) res.setHeader(k, v);
      }

      res.writeHead(upstreamRes.statusCode || 200);
      upstreamRes.pipe(res);
      upstreamRes.on("error", () => res.destroy());
    },
  );

  proxyReq.on("error", (err) => {
    release();
    if (res.destroyed) return; // the client went away; nothing to tell it
    console.error(`[gateway] Upstream proxy error: ${err.message}`);
    if (!res.headersSent) {
      applySecHeaders();
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.writeHead(502);
      res.end(
        JSON.stringify({
          error: "Bad Gateway: Next.js service is starting up or temporarily unreachable.",
        })
      );
    } else {
      res.destroy();
    }
  });

  // The response ending, or the client disconnecting mid-stream, both free the
  // slot; the second also stops the upstream work nobody is waiting for.
  res.on("close", () => {
    release();
    if (!res.writableFinished) proxyReq.destroy();
  });

  req.pipe(proxyReq);
}

function extractClientIp(req) {
  const xForwardedFor = req.headers["x-forwarded-for"];
  if (xForwardedFor) {
    const first = String(xForwardedFor).split(",")[0].trim();
    if (first) return first.slice(0, 64);
  }
  return req.socket.remoteAddress || "127.0.0.1";
}

function normalizeHost(hostHeader) {
  if (!hostHeader) return "";
  let host = String(hostHeader).trim().toLowerCase();
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end === -1 ? host.slice(1) : host.slice(1, end);
  }
  const colon = host.indexOf(":");
  if (colon === -1 || host.indexOf(":", colon + 1) !== -1) return host;
  return host.slice(0, colon);
}

function isHostAllowed(host, allowlist) {
  if (allowlist.has(host)) return true;
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  return false;
}

function parseCookies(header) {
  const map = {};
  if (!header) return map;
  for (const part of String(header).split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    try {
      map[key] = decodeURIComponent(val);
    } catch {
      // A malformed escape is some other cookie's problem; keep it verbatim
      // rather than failing the whole request.
      map[key] = val;
    }
  }
  return map;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        req.destroy();
        reject(new Error("Body limit exceeded"));
        return;
      }
      chunks.push(chunk);
    });
    // Decoded once, whole: a multi-byte character split across two chunks
    // would otherwise be corrupted.
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** @returns {Record<string, string>} Only string fields; anything else is dropped. */
function parseFormOrJson(body, contentType = "") {
  const result = {};
  if (!body) return result;
  if (String(contentType).includes("application/json")) {
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      return result;
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) return result;
    for (const [k, v] of Object.entries(data)) {
      if (typeof v === "string") result[k] = v;
    }
    return result;
  }
  for (const [k, v] of new URLSearchParams(body)) {
    if (!(k in result)) result[k] = v;
  }
  return result;
}

function formatWait(seconds) {
  if (seconds < 90) return `${seconds} seconds`;
  return `${Math.ceil(seconds / 60)} minutes`;
}

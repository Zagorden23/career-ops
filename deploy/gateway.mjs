/**
 * deploy/gateway.mjs
 * Production Auth & Security Gateway for Career Ops on Render.
 *
 * Sits in front of Next.js to provide:
 * 1. Single-owner authentication perimeter (session verification before reaching Next.js).
 * 2. Protection for all pages and APIs (401 for API, redirect to /login for pages).
 * 3. Health check at /healthz (zero-overhead, no auth).
 * 4. Login rate limiting with exponential back-off and temporary lockout.
 * 5. CSRF defense: SameSite cookies, Sec-Fetch-Site validation, Origin checking.
 * 6. Security headers: CSP, HSTS, X-Frame-Options, nosniff, Referrer-Policy, Permissions-Policy.
 * 7. Cloud-mode capability gates: fails safely for features requiring desktop interaction.
 * 8. Host and reverse-proxy validation.
 */

import http from "node:http";
import crypto from "node:crypto";
import { AuthStore } from "./auth-store.mjs";
import { LoginRateLimiter } from "./rate-limiter.mjs";
import { verifyPassword } from "./hash-password.mjs";
import { getSecurityHeaders } from "./security-headers.mjs";
import { renderLoginPage } from "./login-page.mjs";

const MAX_BODY_SIZE = 100 * 1024; // 100KB max body for login

export function createGateway({
  authStore,
  rateLimiter,
  ownerUser,
  ownerPasswordHash,
  upstreamHost = "127.0.0.1",
  upstreamPort = 3001,
  allowedHosts = [],
  isCloud = false,
}) {
  if (!ownerUser) throw new Error("ownerUser is required for gateway");
  if (!ownerPasswordHash) throw new Error("ownerPasswordHash is required for gateway");
  if (!authStore) throw new Error("authStore is required for gateway");
  if (!rateLimiter) rateLimiter = new LoginRateLimiter();

  // Normalized set of allowed hosts
  const hostAllowlist = new Set(
    ["localhost", "127.0.0.1", "[::1]", ...allowedHosts]
      .filter(Boolean)
      .map((h) => normalizeHost(h))
  );

  // Transient login CSRF tokens (5 minute TTL)
  /** @type {Map<string, number>} */
  const loginCsrfTokens = new Map();
  const cleanupLoginTokens = setInterval(() => {
    const now = Date.now();
    for (const [token, exp] of loginCsrfTokens.entries()) {
      if (exp <= now) loginCsrfTokens.delete(token);
    }
  }, 60_000);
  if (cleanupLoginTokens.unref) cleanupLoginTokens.unref();

  function issueLoginCsrfToken() {
    const token = crypto.randomBytes(24).toString("hex");
    loginCsrfTokens.set(token, Date.now() + 5 * 60 * 1000);
    return token;
  }

  function verifyLoginCsrfToken(token) {
    if (!token || typeof token !== "string") return false;
    const exp = loginCsrfTokens.get(token);
    if (!exp) return false;
    loginCsrfTokens.delete(token); // one-time use
    return Date.now() <= exp;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
    const pathname = url.pathname;

    const isHttps =
      req.headers["x-forwarded-proto"] === "https" ||
      Boolean(req.socket.encrypted);

    const clientIp = extractClientIp(req);

    // Apply security headers helper
    const secHeaders = getSecurityHeaders({ isHttps });
    const applySecHeaders = () => {
      for (const [k, v] of Object.entries(secHeaders)) {
        res.setHeader(k, v);
      }
    };

    // 1. Host validation
    const rawHost = req.headers.host || "";
    const normalizedHost = normalizeHost(rawHost);
    if (!normalizedHost || !isHostAllowed(normalizedHost, hostAllowlist)) {
      applySecHeaders();
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.writeHead(403);
      res.end(JSON.stringify({ error: "Forbidden: unauthorized Host header" }));
      return;
    }

    // 2. Health check endpoint — fast, public, zero-auth
    if (pathname === "/healthz" || pathname === "/health") {
      applySecHeaders();
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.writeHead(200);
      res.end(JSON.stringify({ status: "ok", timestamp: new Date().toISOString() }));
      return;
    }

    // Cookie configuration
    const cookieName = isHttps ? "__Host-career_ops_session" : "career_ops_session";
    const cookies = parseCookies(req.headers.cookie);
    const sessionId = cookies[cookieName] || cookies["career_ops_session"];

    // 3. Login routes
    if (pathname === "/login") {
      applySecHeaders();

      if (req.method === "GET") {
        // If already authenticated, redirect to /
        if (sessionId && authStore.getSession(sessionId)) {
          res.writeHead(302, { Location: "/" });
          res.end();
          return;
        }

        const token = issueLoginCsrfToken();
        const html = renderLoginPage({ csrfToken: token });
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.writeHead(200);
        res.end(html);
        return;
      }

      if (req.method === "POST") {
        // Check rate limiter
        const rateCheck = rateLimiter.check(clientIp);
        if (!rateCheck.allowed) {
          const token = issueLoginCsrfToken();
          const html = renderLoginPage({
            csrfToken: token,
            error: rateCheck.reason || "Too many failed attempts. Please wait.",
          });
          res.setHeader("Retry-After", String(rateCheck.retryAfterSeconds || 60));
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.writeHead(429);
          res.end(html);
          return;
        }

        // Read and parse login body
        let bodyStr = "";
        try {
          bodyStr = await readBody(req, MAX_BODY_SIZE);
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Request payload too large" }));
          return;
        }

        const params = parseFormOrJson(bodyStr, req.headers["content-type"]);
        const username = params.username?.trim();
        const password = params.password;
        const csrfToken = params.csrf_token;

        const csrfValid = verifyLoginCsrfToken(csrfToken);
        const credentialsValid =
          csrfValid &&
          username === ownerUser &&
          verifyPassword(password, ownerPasswordHash);

        if (!credentialsValid) {
          rateLimiter.recordFailure(clientIp);
          const delayMs = rateLimiter.getDelayMs(clientIp);
          if (delayMs > 0) {
            await new Promise((r) => setTimeout(r, delayMs));
          }

          const token = issueLoginCsrfToken();
          const errorMessage = !csrfValid
            ? "Session expired or invalid form submission. Please try again."
            : "Invalid username or password.";

          // If client asked for JSON, return JSON 401
          if (req.headers.accept?.includes("application/json")) {
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.writeHead(401);
            res.end(JSON.stringify({ error: errorMessage }));
            return;
          }

          const html = renderLoginPage({ csrfToken: token, error: errorMessage });
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.writeHead(401);
          res.end(html);
          return;
        }

        // Login successful
        rateLimiter.recordSuccess(clientIp);
        const session = authStore.createSession(username);

        const cookieFlags = [
          `${cookieName}=${session.id}`,
          "Path=/",
          "HttpOnly",
          "SameSite=Lax",
        ];
        if (isHttps) cookieFlags.push("Secure");
        cookieFlags.push(`Max-Age=${Math.floor(authStore.maxAgeMs / 1000)}`);

        // Also issue readable CSRF token cookie for frontend fetch requests
        const csrfCookieFlags = [
          `career_ops_csrf=${session.csrfToken}`,
          "Path=/",
          "SameSite=Lax",
        ];
        if (isHttps) csrfCookieFlags.push("Secure");
        csrfCookieFlags.push(`Max-Age=${Math.floor(authStore.maxAgeMs / 1000)}`);

        res.setHeader("Set-Cookie", [cookieFlags.join("; "), csrfCookieFlags.join("; ")]);

        if (req.headers.accept?.includes("application/json")) {
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.writeHead(200);
          res.end(JSON.stringify({ ok: true, csrfToken: session.csrfToken }));
          return;
        }

        res.writeHead(303, { Location: "/" });
        res.end();
        return;
      }

      res.writeHead(405);
      res.end();
      return;
    }

    // 4. Logout route
    if (pathname === "/logout") {
      applySecHeaders();
      if (sessionId) {
        authStore.destroySession(sessionId);
      }
      const clearSessionCookie = `${cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${isHttps ? "; Secure" : ""}`;
      const clearCsrfCookie = `career_ops_csrf=; Path=/; SameSite=Lax; Max-Age=0${isHttps ? "; Secure" : ""}`;
      res.setHeader("Set-Cookie", [clearSessionCookie, clearCsrfCookie]);

      if (req.headers.accept?.includes("application/json")) {
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      res.writeHead(303, { Location: "/login" });
      res.end();
      return;
    }

    // 5. Authentication check for all other routes
    const session = sessionId ? authStore.getSession(sessionId) : null;
    if (!session) {
      applySecHeaders();
      const isApi = pathname.startsWith("/api/") || req.headers.accept?.includes("application/json");

      if (isApi) {
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.writeHead(401);
        res.end(JSON.stringify({ error: "Unauthorized: valid session required" }));
        return;
      }

      // Page request: redirect to login
      res.writeHead(302, { Location: "/login" });
      res.end();
      return;
    }

    // Authenticated! Slide session activity
    authStore.touchSession(sessionId);

    // 6. CSRF protection on mutating requests (POST, PUT, DELETE, PATCH)
    const isMutating = ["POST", "PUT", "DELETE", "PATCH"].includes(req.method || "");
    if (isMutating) {
      const secFetchSite = req.headers["sec-fetch-site"];
      if (secFetchSite && secFetchSite === "cross-site") {
        applySecHeaders();
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.writeHead(403);
        res.end(JSON.stringify({ error: "Forbidden: cross-site request rejected" }));
        return;
      }

      const origin = req.headers.origin;
      if (origin) {
        try {
          const originHost = normalizeHost(new URL(origin).host);
          if (originHost !== normalizedHost && !isHostAllowed(originHost, hostAllowlist)) {
            applySecHeaders();
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.writeHead(403);
            res.end(JSON.stringify({ error: "Forbidden: cross-origin request rejected" }));
            return;
          }
        } catch {
          applySecHeaders();
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.writeHead(403);
          res.end(JSON.stringify({ error: "Forbidden: invalid Origin" }));
          return;
        }
      }
    }

    // 7. Cloud-mode capability check (Requirement 5)
    if (isCloud && pathname.startsWith("/api/apply/")) {
      // Apply mode requires local headed Chrome with human handoff window
      applySecHeaders();
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.writeHead(501);
      res.end(
        JSON.stringify({
          error: "Apply mode requires a local desktop browser with human handoff and is not available in cloud deployment. Please use the local Career Ops CLI.",
          unsupportedInCloud: true,
        })
      );
      return;
    }

    // 8. Proxy authenticated request to Next.js upstream
    proxyRequest({
      req,
      res,
      upstreamHost,
      upstreamPort,
      session,
      isHttps,
      applySecHeaders,
    });
  });

  return server;
}

function proxyRequest({ req, res, upstreamHost, upstreamPort, session, isHttps, applySecHeaders }) {
  const forwardedHeaders = { ...req.headers };

  // Set standard proxy headers
  forwardedHeaders["x-forwarded-for"] = extractClientIp(req);
  forwardedHeaders["x-forwarded-proto"] = isHttps ? "https" : "http";
  forwardedHeaders["x-forwarded-host"] = req.headers.host || "";
  forwardedHeaders["x-career-ops-user"] = session.user;

  // Next.js upstream options
  const options = {
    hostname: upstreamHost,
    port: upstreamPort,
    path: req.url,
    method: req.method,
    headers: forwardedHeaders,
  };

  const proxyReq = http.request(options, (upstreamRes) => {
    applySecHeaders();

    // Copy upstream headers except those overridden by security policy
    for (const [k, v] of Object.entries(upstreamRes.headers)) {
      const lower = k.toLowerCase();
      if (
        lower !== "content-security-policy" &&
        lower !== "x-frame-options" &&
        lower !== "x-content-type-options" &&
        lower !== "strict-transport-security" &&
        lower !== "referrer-policy" &&
        lower !== "permissions-policy"
      ) {
        res.setHeader(k, v);
      }
    }

    res.writeHead(upstreamRes.statusCode || 200);
    upstreamRes.pipe(res);
  });

  proxyReq.on("error", (err) => {
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
    }
  });

  req.pipe(proxyReq);
}

function extractClientIp(req) {
  const xForwardedFor = req.headers["x-forwarded-for"];
  if (xForwardedFor) {
    const first = String(xForwardedFor).split(",")[0].trim();
    if (first) return first;
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
  const parts = header.split(";");
  for (const part of parts) {
    const idx = part.indexOf("=");
    if (idx !== -1) {
      const key = part.slice(0, idx).trim();
      const val = part.slice(idx + 1).trim();
      map[key] = decodeURIComponent(val);
    }
  }
  return map;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let data = "";
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        req.destroy();
        reject(new Error("Body limit exceeded"));
        return;
      }
      data += chunk;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function parseFormOrJson(body, contentType = "") {
  if (!body) return {};
  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(body);
    } catch {
      return {};
    }
  }
  const result = {};
  const pairs = body.split("&");
  for (const pair of pairs) {
    const [k, v] = pair.split("=");
    if (k) {
      result[decodeURIComponent(k.replace(/\+/g, " "))] = decodeURIComponent((v || "").replace(/\+/g, " "));
    }
  }
  return result;
}

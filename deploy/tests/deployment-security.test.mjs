/**
 * deploy/tests/deployment-security.test.mjs
 * Comprehensive integration and security test suite for Career Ops Render deployment.
 *
 * Verifies:
 * 1. Password hashing (scrypt) & timing-safe verification
 * 2. Persistent session storage (disk persistence across restarts, expiration, CSRF)
 * 3. Login rate limiter (failed attempt tracking, exponential back-off, lockouts)
 * 4. Security headers (CSP, HSTS, X-Frame-Options, nosniff, Referrer-Policy)
 * 5. Gateway health check (/healthz)
 * 6. Host validation (rejection of malicious/spoofed Host headers)
 * 7. Single-owner authentication perimeter (unauthenticated page -> 302, API -> 401)
 * 8. Login flow (bad password -> 401, correct password -> session cookie & 303)
 * 9. Authenticated request proxying (security headers, user context, upstream piping)
 * 10. Mutating CSRF defense (Sec-Fetch-Site and Origin verification)
 * 11. Cloud capability gate (rejection of desktop-only apply mode in cloud)
 * 12. Logout flow (cookie clearing & durable session destruction)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { hashPassword, verifyPassword } from "../hash-password.mjs";
import { AuthStore } from "../auth-store.mjs";
import { LoginRateLimiter } from "../rate-limiter.mjs";
import { getSecurityHeaders, CSP_HEADER_VALUE } from "../security-headers.mjs";
import { createGateway } from "../gateway.mjs";
import { verifyPersistentStorage, REQUIRED_USER_DIRS } from "../storage-check.mjs";

test("1. Password hashing and timing-safe verification", () => {
  const secret = "SuperSecretPassword123!#";
  const hash = hashPassword(secret);

  assert.ok(hash.startsWith("scrypt:"), "Hash format must start with scrypt:");
  const parts = hash.split(":");
  assert.equal(parts.length, 3, "Hash must have format scrypt:salt:key");
  assert.equal(parts[1].length, 32, "Salt must be 16 bytes (32 hex chars)");
  assert.equal(parts[2].length, 128, "Derived key must be 64 bytes (128 hex chars)");

  // Verify correct password
  assert.equal(verifyPassword(secret, hash), true, "Correct password must verify successfully");

  // Verify wrong password
  assert.equal(verifyPassword("WrongPassword123!", hash), false, "Wrong password must be rejected");

  // Verify corrupted/tampered hash
  assert.equal(verifyPassword(secret, "scrypt:invalid:hash"), false, "Corrupted hash must fail safely");
  assert.equal(verifyPassword(secret, "md5:invalid:hash"), false, "Non-scrypt format must fail safely");
  assert.equal(verifyPassword(secret, ""), false, "Empty hash must fail safely");
});

test("2. Persistent session store across restarts and lifecycle", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "co-auth-test-"));
  try {
    const store1 = new AuthStore({ sessionDir: tmpDir, maxAgeMs: 5000, idleTimeoutMs: 2000 });
    const session1 = store1.createSession("owner-user");

    assert.ok(session1.id && session1.id.length >= 64, "Session ID must be 256-bit hex");
    assert.ok(session1.csrfToken && session1.csrfToken.length >= 48, "Session must have CSRF token");
    assert.equal(session1.user, "owner-user");

    // CSRF validation
    assert.equal(store1.validateCsrf(session1.id, session1.csrfToken), true);
    assert.equal(store1.validateCsrf(session1.id, "fake-csrf-token"), false);

    // Simulate service restart: create a new AuthStore pointing to the same directory
    const store2 = new AuthStore({ sessionDir: tmpDir, maxAgeMs: 5000, idleTimeoutMs: 2000 });
    const restored = store2.getSession(session1.id);
    assert.ok(restored, "Session MUST survive service restart via persistent disk");
    assert.equal(restored.user, "owner-user");
    assert.equal(restored.csrfToken, session1.csrfToken);

    // Destroy session (logout)
    assert.equal(store2.destroySession(session1.id), true);
    assert.equal(store2.getSession(session1.id), null);

    // Verify destroyed session stays destroyed across another restart
    const store3 = new AuthStore({ sessionDir: tmpDir, maxAgeMs: 5000, idleTimeoutMs: 2000 });
    assert.equal(store3.getSession(session1.id), null, "Destroyed session must not reappear");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("3. Login rate limiter tracks failures and locks out", () => {
  const limiter = new LoginRateLimiter({
    maxAttempts: 3,
    windowMs: 5000,
    lockoutMs: 5000,
  });

  const testIp = "192.168.1.100";
  assert.equal(limiter.check(testIp).allowed, true, "Initial attempt must be allowed");

  // Record 2 failures
  limiter.recordFailure(testIp);
  assert.equal(limiter.check(testIp).allowed, true);
  assert.equal(limiter.getDelayMs(testIp), 0);

  limiter.recordFailure(testIp);
  assert.equal(limiter.check(testIp).allowed, true);
  assert.ok(limiter.getDelayMs(testIp) > 0, "Progressive delay should kick in");

  // 3rd failure reaches maxAttempts -> lockout
  limiter.recordFailure(testIp);
  const checkAfter3 = limiter.check(testIp);
  assert.equal(checkAfter3.allowed, false, "After maxAttempts IP must be locked out");
  assert.ok(checkAfter3.retryAfterSeconds > 0);

  // Success resets failure count
  limiter.recordSuccess(testIp);
  assert.equal(limiter.check(testIp).allowed, true, "Successful login resets limiter");

  limiter.destroy();
});

test("4. Security headers generation", () => {
  const httpHeaders = getSecurityHeaders({ isHttps: false });
  assert.equal(httpHeaders["Content-Security-Policy"], CSP_HEADER_VALUE);
  assert.equal(httpHeaders["X-Content-Type-Options"], "nosniff");
  assert.equal(httpHeaders["X-Frame-Options"], "DENY");
  assert.equal(httpHeaders["Referrer-Policy"], "strict-origin-when-cross-origin");
  assert.ok(httpHeaders["Permissions-Policy"].includes("camera=()"));
  assert.equal(httpHeaders["Strict-Transport-Security"], undefined, "HSTS should not be set over plain HTTP");

  const httpsHeaders = getSecurityHeaders({ isHttps: true });
  assert.ok(
    httpsHeaders["Strict-Transport-Security"].includes("max-age=63072000"),
    "HSTS must be present and enforce 2 years over HTTPS"
  );
});

test("5. Gateway End-to-End Authentication & Security Perimeter", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "co-gw-test-"));
  const authStore = new AuthStore({ sessionDir: tmpDir });
  const rateLimiter = new LoginRateLimiter();
  const ownerUser = "admin";
  const ownerPassword = "CorrectHorseBatteryStaple!";
  const ownerPasswordHash = hashPassword(ownerPassword);

  // 1. Create mock upstream Next.js server
  let upstreamHit = false;
  let receivedHeaders = null;
  const upstreamServer = http.createServer((req, res) => {
    upstreamHit = true;
    receivedHeaders = req.headers;
    if (req.url === "/api/status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "healthy", internal: true }));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<html><body>Dashboard Content</body></html>");
  });

  await new Promise((resolve) => upstreamServer.listen(0, "127.0.0.1", resolve));
  const upstreamPort = upstreamServer.address().port;

  // 2. Create and start Gateway
  const gateway = createGateway({
    authStore,
    rateLimiter,
    ownerUser,
    ownerPasswordHash,
    upstreamHost: "127.0.0.1",
    upstreamPort,
    allowedHosts: ["localhost", "127.0.0.1", "career-ops.onrender.com"],
    isCloud: true,
  });

  await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const gatewayPort = gateway.address().port;
  const baseUrl = `http://127.0.0.1:${gatewayPort}`;

  try {
    // 5A. Health check endpoint (public, unauthenticated)
    const healthRes = await fetch(`${baseUrl}/healthz`);
    assert.equal(healthRes.status, 200, "Health check must return 200");
    const healthData = await healthRes.json();
    assert.equal(healthData.status, "ok");
    assert.ok(healthRes.headers.get("x-content-type-options") === "nosniff");

    // 5B. Foreign / spoofed Host header rejection
    const badHostRes = await new Promise((resolve) => {
      const r = http.request({
        hostname: "127.0.0.1",
        port: gatewayPort,
        path: "/healthz",
        headers: { Host: "evil-attacker-site.com" },
      }, (res) => {
        resolve({ status: res.statusCode });
      });
      r.end();
    });
    assert.equal(badHostRes.status, 403, "Requests with foreign Host must be rejected with 403");

    // 5C. Unauthenticated page request -> Redirect to /login
    const unauthPageRes = await fetch(`${baseUrl}/`, { redirect: "manual" });
    assert.equal(unauthPageRes.status, 302, "Unauthenticated page request must redirect to /login");
    assert.equal(unauthPageRes.headers.get("location"), "/login");

    // 5D. Unauthenticated API request -> 401 Unauthorized
    const unauthApiRes = await fetch(`${baseUrl}/api/status`);
    assert.equal(unauthApiRes.status, 401, "Unauthenticated API request must return 401");
    const unauthApiData = await unauthApiRes.json();
    assert.ok(unauthApiData.error, "Must return error JSON");
    assert.equal(upstreamHit, false, "Upstream Next.js MUST NOT be reached by unauthenticated caller");

    // 5E. Fetch login page and extract CSRF token
    const loginPageRes = await fetch(`${baseUrl}/login`);
    assert.equal(loginPageRes.status, 200);
    const loginHtml = await loginPageRes.text();
    assert.ok(loginHtml.includes("Career Ops"), "Login page must render title");
    assert.ok(loginHtml.includes('name="csrf_token"'), "Login page must include CSRF token input");

    const csrfMatch = loginHtml.match(/name="csrf_token" value="([a-f0-9]+)"/);
    assert.ok(csrfMatch, "Must extract CSRF token from login HTML");
    const loginCsrfToken = csrfMatch[1];

    // 5F. Attempt login with bad password -> 401
    const badLoginRes = await fetch(`${baseUrl}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        username: "admin",
        password: "WrongPassword!",
        csrf_token: loginCsrfToken,
      }),
      redirect: "manual",
    });
    assert.equal(badLoginRes.status, 401, "Invalid password must return 401");

    // 5G. Fetch new login page (since token is one-time use) and login with correct credentials
    const loginPageRes2 = await fetch(`${baseUrl}/login`);
    const loginHtml2 = await loginPageRes2.text();
    const csrfMatch2 = loginHtml2.match(/name="csrf_token" value="([a-f0-9]+)"/);
    const validLoginCsrfToken = csrfMatch2[1];

    const goodLoginRes = await fetch(`${baseUrl}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        username: "admin",
        password: ownerPassword,
        csrf_token: validLoginCsrfToken,
      }),
      redirect: "manual",
    });

    assert.equal(goodLoginRes.status, 303, "Valid login must redirect (303) to /");
    assert.equal(goodLoginRes.headers.get("location"), "/");

    const setCookie = goodLoginRes.headers.get("set-cookie");
    assert.ok(setCookie, "Must set session cookie on login");
    assert.ok(setCookie.includes("career_ops_session="), "Cookie must contain session ID");
    assert.ok(setCookie.includes("HttpOnly"), "Cookie must be HttpOnly");
    assert.ok(setCookie.includes("SameSite=Lax"), "Cookie must be SameSite=Lax");

    // Extract cookie value for subsequent requests
    const cookieHeader = setCookie
      .split(",")
      .map((c) => c.split(";")[0].trim())
      .join("; ");

    // 5H. Authenticated page request -> Proxied to upstream Next.js
    upstreamHit = false;
    const authPageRes = await fetch(`${baseUrl}/pipeline`, {
      headers: { Cookie: cookieHeader },
    });
    assert.equal(authPageRes.status, 200);
    assert.equal(upstreamHit, true, "Authenticated request must reach upstream");
    assert.equal(receivedHeaders["x-career-ops-user"], "admin", "Upstream must receive authenticated user header");
    assert.equal(authPageRes.headers.get("x-frame-options"), "DENY", "Security headers must be present on response");
    assert.equal(authPageRes.headers.get("x-content-type-options"), "nosniff");

    // 5I. Authenticated API request
    upstreamHit = false;
    const authApiRes = await fetch(`${baseUrl}/api/status`, {
      headers: { Cookie: cookieHeader },
    });
    assert.equal(authApiRes.status, 200);
    assert.equal(upstreamHit, true);
    const authApiData = await authApiRes.json();
    assert.equal(authApiData.status, "healthy");

    // 5J. Mutating CSRF protection: cross-site Sec-Fetch-Site must be blocked
    const crossSiteRes = await fetch(`${baseUrl}/api/status`, {
      method: "POST",
      headers: {
        Cookie: cookieHeader,
        "Sec-Fetch-Site": "cross-site",
      },
    });
    assert.equal(crossSiteRes.status, 403, "Cross-site mutating request must be rejected with 403");

    // 5K. Mutating CSRF protection: mismatched Origin must be blocked
    const badOriginRes = await fetch(`${baseUrl}/api/status`, {
      method: "POST",
      headers: {
        Cookie: cookieHeader,
        Origin: "https://attacker.evil.com",
      },
    });
    assert.equal(badOriginRes.status, 403, "Mismatched Origin must be rejected with 403");

    // 5L. Cloud capability gate: Apply mode blocked in cloud
    const cloudApplyRes = await fetch(`${baseUrl}/api/apply/session`, {
      headers: { Cookie: cookieHeader },
    });
    assert.equal(cloudApplyRes.status, 501, "Apply mode must return 501 in cloud deployment");
    const cloudApplyData = await cloudApplyRes.json();
    assert.equal(cloudApplyData.unsupportedInCloud, true);

    // 5M. Logout
    const logoutRes = await fetch(`${baseUrl}/logout`, {
      method: "POST",
      headers: { Cookie: cookieHeader },
      redirect: "manual",
    });
    assert.equal(logoutRes.status, 303, "Logout must redirect to /login");
    assert.equal(logoutRes.headers.get("location"), "/login");
    const logoutCookie = logoutRes.headers.get("set-cookie");
    assert.ok(logoutCookie.includes("Max-Age=0"), "Logout must expire cookie");

    // Subsequent request with old cookie must fail
    const postLogoutRes = await fetch(`${baseUrl}/api/status`, {
      headers: { Cookie: cookieHeader },
    });
    assert.equal(postLogoutRes.status, 401, "Request with invalidated session must be 401");
  } finally {
    gateway.close();
    upstreamServer.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("6. Persistent storage verification and seed layout", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "co-storage-test-"));
  try {
    const dataRoot = path.join(tmpDir, "career-ops");
    const result = verifyPersistentStorage(dataRoot);
    assert.equal(result.ok, true);

    // Verify all required user dirs are created
    for (const d of REQUIRED_USER_DIRS) {
      assert.ok(fs.existsSync(path.join(dataRoot, d)), `Directory ${d} must be created`);
    }

    // Second call on already existing directory
    const result2 = verifyPersistentStorage(dataRoot);
    assert.equal(result2.ok, true);
    assert.equal(result2.seededDirs.length, 0, "No new directories should be seeded on re-run");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

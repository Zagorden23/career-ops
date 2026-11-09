# Career Ops Security Audit & Hardening Specification

**Scope:** Production Deployment on Render  
**Target:** Private Single-Owner Installation (`feature/render-private-deployment`)  
**Status:** IMPLEMENTED & VERIFIED  

---

## 1. Executive Summary

Career Ops is a local-first career management and job search system. In its stock configuration, it relies exclusively on network binding (`127.0.0.1`) and basic `Host` / `Origin` header checking for protection. When deployed to a public cloud environment like Render, exposing the stock application without authentication creates a critical vulnerability: arbitrary visitors could view personal application histories, salary targets, CVs, and potentially trigger child processes.

This audit specifies and verifies the **Production Auth & Security Gateway** architecture implemented in `deploy/`. The solution converts Career Ops into a hardened, authenticated, persistent single-owner cloud deployment without altering the underlying Next.js/React application code or upstream contracts.

---

## 2. Threat Model & Asset Inventory

### Assets at Risk
1. **Personal Identity & CV Data:** `cv.md`, `config/profile.yml`, `modes/_profile.md`, portfolio digests.
2. **Confidential Search Data:** `data/applications.md` (application tracker, compensation notes, interview feedback, contact details).
3. **Execution Environment:** API endpoints that invoke Node scripts or AI processes.

### Threat Vectors Mitigated
- **Public Unauthorized Access:** Unauthenticated internet users hitting endpoints.
- **Credential Brute-Force:** Distributed or rapid automated dictionary attacks on the login endpoint.
- **CSRF / Drive-by Exploits:** Cross-site requests attempting to trigger actions or state mutations.
- **DNS Rebinding & Host Spoofing:** Requests presenting arbitrary `Host` headers to bypass routing checks.
- **Clickjacking & Frame Embedding:** Embedding Career Ops within an attacker iframe.
- **Data Loss on Redeployment:** Files written to ephemeral disk disappearing on container restart.
- **Unsupported Cloud Features:** Desktop-dependent CLI/browser actions failing unpredictably or silently.

---

## 3. Architecture: The Two-Tier Perimeter

```
                           INTERNET / CLIENT
                                  │
                                  ▼
           [ Render Reverse Proxy (TLS Termination, DDoS) ]
                                  │  Port $PORT
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│               Career Ops Security Gateway (0.0.0.0)             │
│                                                                 │
│  - Host Header Allowlist Verification                           │
│  - /healthz Public Healthcheck                                  │
│  - Login Rate Limiter (Sliding Window + Exponential Lockout)    │
│  - Self-Contained Professional Login Interface                  │
│  - Scrypt Password Verification (Constant-Time Equal)           │
│  - Persistent Session Store (/var/data/career-ops/.sessions)    │
│  - CSRF Defense (SameSite + Sec-Fetch-Site + Origin Check)      │
│  - Cloud Capability Filter (blocks desktop-only Apply mode)     │
│  - Response Security Headers (CSP, HSTS, X-Frame-Options, etc.) │
└────────────────────────────────┬────────────────────────────────┘
                                 │ Loopback Only (127.0.0.1:INTERNAL_PORT)
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│              Internal Next.js Production Service                │
│                                                                 │
│  - App Router, React Components, API Routes                     │
│  - origin-guard.mjs (Second-Layer Defense)                      │
│  - Read/Write to Persistent Data Root (/var/data/career-ops)    │
└─────────────────────────────────────────────────────────────────┘
```

### Perimeter Invariant
The Next.js production server binds **strictly to loopback `127.0.0.1`** on an unexposed internal port. Only the Gateway (`deploy/gateway.mjs`) binds to `0.0.0.0:$PORT`. It is physically impossible for an external request to reach Next.js or any API endpoint without passing through the Gateway's authentication logic.

---

## 4. Authentication & Session Security

### Single-Owner Model
- No public user registration.
- No default accounts, credentials, or secrets in code.
- Credentials configured solely via Render environment secrets:
  - `CAREER_OPS_AUTH_USER`: Owner username.
  - `CAREER_OPS_AUTH_PASSWORD_HASH`: Cryptographic password hash.

### Password Hashing (`deploy/hash-password.mjs`)
- Algorithm: Node.js native `crypto.scryptSync`.
- Parameters: `N = 16384`, `r = 8`, `p = 1`, `maxmem = 32MB`.
- Salt: 16 bytes (128-bit) cryptographically secure random bytes per hash.
- Key Length: 64 bytes (512-bit) derived key.
- Storage Format: `scrypt:<salt-hex>:<derived-key-hex>`.
- Comparison: Constant-time verification using `crypto.timingSafeEqual` prevents side-channel timing attacks.

### Login Rate Limiting (`deploy/rate-limiter.mjs`)
- Sliding window tracker over 15-minute periods.
- Progressive back-off delay kicks in after 2 consecutive failures (500ms -> 1000ms -> 2000ms).
- Hard lockout: 5 failed attempts locks out the client IP for 15 minutes (HTTP 429 Too Many Requests).
- Global failure ceiling: prevents distributed brute force across multiple IP addresses.
- Instant reset on successful authentication.

### Persistent Sessions (`deploy/auth-store.mjs`)
- Session IDs: 256-bit cryptographically secure random tokens (`crypto.randomBytes(32)`).
- Storage: Stored on the persistent disk at `${CAREER_OPS_ROOT}/.sessions/sessions.json`.
- Atomic writes: Temp file write followed by `fs.renameSync` prevents file corruption during sudden restarts.
- Expiration Policy:
  - **Absolute Expiry:** 7 days maximum lifetime.
  - **Idle Expiry:** 24 hours of inactivity slides expiry.
- Cookie Attributes:
  - Name: `__Host-career_ops_session` (in HTTPS) or `career_ops_session` (local test).
  - Flags: `HttpOnly; SameSite=Lax; Path=/; Secure; Max-Age=604800`.
  - The `__Host-` prefix enforces that the cookie is secure, path is `/`, and cannot be overwritten by subdomains.
- Logout: Calling `POST /logout` invalidates the session in the persistent store and sets `Max-Age=0` on the cookie.

---

## 5. Request & Origin Defense

### Cross-Site Request Forgery (CSRF)
Three independent layers protect state-changing requests (`POST`, `PUT`, `DELETE`, `PATCH`):
1. **Cookie Partitioning:** `SameSite=Lax` prevents cookies from being attached to cross-site image, script, or iframe requests.
2. **Fetch Metadata:** `Sec-Fetch-Site` header is verified; any request marked `cross-site` is immediately rejected with HTTP 403.
3. **Origin Validation:** If `Origin` is present, it must strictly match the allowed host.
4. **Form CSRF:** The login form utilizes one-time cryptographically generated CSRF tokens with short 5-minute lifetimes.

### Host Header Validation
- Requests are validated against an explicit allowlist:
  - `RENDER_EXTERNAL_HOSTNAME` (injected by Render, e.g. `career-ops.onrender.com`).
  - `CAREER_OPS_WEB_ALLOWED_HOSTS` (custom domains).
  - Loopback addresses (`127.0.0.1`, `localhost`).
- Spoofed or foreign `Host` headers return `403 Forbidden` immediately before any route handling.

---

## 6. HTTP Security Headers (`deploy/security-headers.mjs`)

Applied to every response emitted by the gateway:

| Header | Configured Value | Security Purpose |
|---|---|---|
| `Content-Security-Policy` | `default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'` | Prevents script injection, clickjacking via frames, unauthorized plugin execution, and form hijacking while maintaining Next.js 16 functionality. |
| `X-Content-Type-Options` | `nosniff` | Prevents MIME-type sniffing. |
| `X-Frame-Options` | `DENY` | Prevents framing in legacy browsers lacking CSP `frame-ancestors`. |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains; preload` | Enforces HTTPS for 2 years (applied on HTTPS connections). |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Limits referer leakage to external domains. |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), browsing-topics=(), payment=(), usb=()` | Disables sensitive browser APIs and ad-tracking APIs. |
| `X-XSS-Protection` | `0` | Disables legacy buggy XSS auditor in favour of modern CSP. |

---

## 7. Persistent Storage & Path Traversal Defense

### Storage Isolation (`deploy/storage-check.mjs`)
- Render Persistent Disk mounted at `/var/data/career-ops`.
- Read & write probe executed before supervisor starts the server.
- The supervisor **fails closed (exits with code 1)** if the persistent mount is missing or read-only, preventing silent data loss on ephemeral storage.
- Standard user directory hierarchy automatically seeded:
  - `data/` (applications tracker, scan history, pipeline)
  - `config/` (profile.yml, portals.yml)
  - `modes/` (_profile.md, _custom.md)
  - `reports/` (A-H evaluation reports)
  - `output/` (generated CVs, summaries)
  - `.sessions/` (persistent session store)

### Path Traversal Defense
- All web file-serving routes in Career Ops use `isRegularContainedFile` and `pdf-index` containment checks.
- Uploads and files outside the data root are rejected.
- Upstream `.gitignore` excludes all user data, credentials, and scratch directories.

---

## 8. AI & Child Process Execution Security

### Process Model
- The supervisor (`deploy/render-start.mjs`) launches Next.js and monitors PID lifecycle.
- Traps `SIGTERM` and `SIGINT`, closes the Gateway listener, forwards signals to children, and reaps all processes within 8 seconds to prevent zombie processes.

### AI CLI Boundary in Cloud
- Local coding CLIs (Hermes, Claude Code, etc.) do not exist in the Render container environment by default.
- `web/src/lib/clis.js` detects installed binaries using fixed paths and binaries.
- If an AI feature is invoked without a CLI installed, `cliUnavailableError()` returns HTTP 404 with a structured error explanation. No mock success is fabricated.
- For Apply mode (`/api/apply/*`), which requires a headed desktop browser and human handoff window, the Gateway intercepts the request in cloud mode (`CAREER_OPS_CLOUD=1`) and returns HTTP 501 Not Implemented with a clear diagnostic message.
- Child process arguments are strictly assembled from internal constants—never from arbitrary client strings.

---

## 9. Verification & Test Suite

All security requirements have been validated through automated tests in `deploy/tests/`:

1. `deploy/tests/deployment-security.test.mjs`
   - Test 1: Password hashing and timing-safe verification -> PASS
   - Test 2: Persistent session store across restarts and lifecycle -> PASS
   - Test 3: Login rate limiter tracks failures and locks out -> PASS
   - Test 4: Security headers generation -> PASS
   - Test 5: Gateway End-to-End Authentication & Security Perimeter -> PASS
     - Healthcheck -> 200
     - Foreign Host rejection -> 403
     - Unauthenticated page -> 302 to /login
     - Unauthenticated API -> 401 JSON
     - Invalid login -> 401
     - Valid login -> 303 + HttpOnly session cookie
     - Authenticated page/API proxying -> 200 + security headers
     - Cross-site CSRF rejection -> 403
     - Origin mismatch rejection -> 403
     - Cloud Apply mode rejection -> 501
     - Logout -> cookie cleared + session invalidated
   - Test 6: Persistent storage verification and seed layout -> PASS

2. `deploy/tests/render-start.test.mjs`
   - Test 7: Supervisor startup, healthcheck, and graceful SIGTERM shutdown -> PASS

#!/usr/bin/env node
/**
 * deploy/render-start.mjs
 * Production entrypoint and supervisor for Career Ops on Render.
 *
 * Responsibilities:
 * 1. Validate environment (owner login, account and sign-in settings).
 * 2. Validate persistent storage: ensures the data root is present and writable.
 * 3. Seed initial user directory structure if first run on fresh volume.
 * 4. Start the Auth & Security Gateway on 0.0.0.0:$PORT.
 * 5. Start one Next.js process per signed-in account, on demand, each on an
 *    internal loopback port and pointed at that account's own data directory.
 * 6. Handle SIGTERM / SIGINT gracefully: stop accepting requests, stop the app
 *    processes, flush storage, exit.
 *
 * An app process that dies is not fatal: it is forgotten and the account's next
 * request starts a new one.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { AuthStore } from "./auth-store.mjs";
import { LoginRateLimiter } from "./rate-limiter.mjs";
import { createGateway } from "./gateway.mjs";
import { verifyPersistentStorage } from "./storage-check.mjs";
import { R2Client } from "./r2-client.mjs";
import { R2StorageAdapter } from "./r2-storage-adapter.mjs";
import { UserStore } from "./user-store.mjs";
import { OtpStore } from "./otp-store.mjs";
import { createEmailSender, createSmsSender } from "./notifiers.mjs";
import { createGoogleOAuth } from "./google-oauth.mjs";
import { WorkspaceManager, OWNER_ACCOUNT_ID, TENANTS_DIRNAME } from "./workspace-manager.mjs";
import { loadAuthConfig, buildWorkerEnv } from "./auth-config.mjs";
import { ensureCloudCliBin } from "./cloud-cli-shim.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const codeRoot = path.resolve(__dirname, "..");
const webDir = path.join(codeRoot, "web");

// 1. Environment validation
const PORT = parseInt(process.env.PORT || "3000", 10);
const AUTH_USER = process.env.CAREER_OPS_AUTH_USER?.trim();
const AUTH_PASSWORD_HASH = process.env.CAREER_OPS_AUTH_PASSWORD_HASH?.trim();
const IS_PRODUCTION = process.env.NODE_ENV === "production";
const IS_CLOUD = process.env.CAREER_OPS_CLOUD === "1" || Boolean(process.env.RENDER);

// R2 Storage configuration
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID?.trim();
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID?.trim();
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY?.trim();
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME?.trim() || "career-ops-data";
const R2_ENDPOINT = process.env.R2_ENDPOINT?.trim();
const USE_R2 = Boolean(R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && (R2_ACCOUNT_ID || R2_ENDPOINT));

// Resolve DATA_ROOT:
// In Render Free with R2, default to /tmp/career-ops-data or local runtime dir if /var/data/career-ops is missing.
let DATA_ROOT = process.env.CAREER_OPS_ROOT?.trim();
if (!DATA_ROOT) {
  if (USE_R2) {
    DATA_ROOT = process.platform === "win32"
      ? path.join(os.tmpdir(), "career-ops-data")
      : "/tmp/career-ops-data";
  } else {
    DATA_ROOT = "/var/data/career-ops";
  }
}
DATA_ROOT = path.resolve(DATA_ROOT);

console.log("==================================================");
console.log("Career Ops Production Supervisor Starting");
console.log(`Port: ${PORT}`);
console.log(`Data Root: ${DATA_ROOT}`);
console.log(`Storage Backend: ${USE_R2 ? `Cloudflare R2 (Bucket: ${R2_BUCKET_NAME})` : "Persistent Disk"}`);
console.log(`Mode: ${IS_PRODUCTION ? "production" : "development"}`);
console.log("==================================================");

// Require credentials in production or when CAREER_OPS_REQUIRE_AUTH=1
if (IS_PRODUCTION || process.env.CAREER_OPS_REQUIRE_AUTH === "1") {
  if (!AUTH_USER) {
    console.error("FATAL: CAREER_OPS_AUTH_USER environment variable is required.");
    process.exit(1);
  }
  if (!AUTH_PASSWORD_HASH || !AUTH_PASSWORD_HASH.startsWith("scrypt:")) {
    console.error("FATAL: CAREER_OPS_AUTH_PASSWORD_HASH must be configured with a valid scrypt hash.");
    console.error("Generate one using: node deploy/hash-password.mjs <your-password>");
    process.exit(1);
  }
}

// Account, sign-in and workspace settings
let authConfig;
let emailSender;
let smsSender;
try {
  authConfig = loadAuthConfig(process.env);
  emailSender = createEmailSender(process.env);
  smsSender = createSmsSender(process.env);
} catch (err) {
  console.error(`FATAL: ${err.message}`);
  process.exit(1);
}
for (const warning of authConfig.warnings) console.warn(`[auth] Warning: ${warning}`);

// 2. Storage validation
try {
  verifyPersistentStorage(DATA_ROOT);
  console.log(`[storage] Verified persistent storage at ${DATA_ROOT}`);
} catch (err) {
  console.error(`FATAL: Storage verification failed: ${err.message}`);
  console.error("Ensure that the persistent storage directory is writable.");
  process.exit(1);
}

// Initialize R2 client and adapter if configured
let r2Client = null;
let r2Adapter = null;
if (USE_R2) {
  r2Client = new R2Client({
    accountId: R2_ACCOUNT_ID,
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
    bucketName: R2_BUCKET_NAME,
    endpoint: R2_ENDPOINT,
  });
  r2Adapter = new R2StorageAdapter({
    client: r2Client,
    localDataRoot: DATA_ROOT,
  });
}

/** An unused loopback port, chosen by the OS. */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Resolve once something accepts connections on the port; reject if the process dies first. */
async function waitForPort(port, exited, timeoutMs) {
  let gone = null;
  exited.then((result) => {
    gone = result;
  });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (gone) throw new Error(`app process exited before it was ready (code=${gone.code} signal=${gone.signal})`);
    const open = await new Promise((resolve) => {
      const socket = net.connect({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    if (open) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`app process did not start listening within ${Math.round(timeoutMs / 1000)}s`);
}

async function main() {
  // Resolve Next.js binary
  const requireFromWeb = createRequire(path.join(webDir, "package.json"));
  let nextBinPath;
  try {
    const manifest = requireFromWeb.resolve("next/package.json");
    nextBinPath = path.join(path.dirname(manifest), requireFromWeb(manifest).bin.next);
  } catch (err) {
    console.error(`FATAL: Cannot resolve next: ${err.message}`);
    console.error("Make sure npm dependencies are installed under web/.");
    process.exit(1);
  }
  if (IS_PRODUCTION && !fs.existsSync(path.join(webDir, ".next", "BUILD_ID"))) {
    console.warn("[supervisor] Warning: web/.next has no production build. Run `npm --prefix web run build`; until then every page will fail to start.");
  }

  // Allowed hosts setup
  const allowedHosts = [
    process.env.RENDER_EXTERNAL_HOSTNAME,
    ...(process.env.CAREER_OPS_WEB_ALLOWED_HOSTS || "").split(/[\s,]+/),
  ].filter(Boolean);

  // If R2 storage is configured, hydrate local working tree before anything
  // reads it: the session and account files live in it too.
  if (r2Adapter) {
    try {
      console.log(`[storage] Hydrating data from Cloudflare R2 bucket '${R2_BUCKET_NAME}'...`);
      const hyd = await r2Adapter.hydrateFromR2();
      console.log(`[storage] R2 hydration done: ${hyd.downloaded} downloaded, ${hyd.skipped} up to date.`);
      r2Adapter.startBackgroundSync();
    } catch (err) {
      console.error(`FATAL: Initial R2 hydration failed: ${err.message}`);
      process.exit(1);
    }
  }

  // Sessions, accounts and rate-limit state
  const sessionDir = process.env.CAREER_OPS_SESSION_DIR || path.join(DATA_ROOT, ".sessions");
  const authStore = new AuthStore({ sessionDir });
  let userStore;
  try {
    userStore = new UserStore({ dir: sessionDir });
  } catch (err) {
    console.error(`FATAL: ${err.message}`);
    process.exit(1);
  }
  const rateLimiter = new LoginRateLimiter({
    stateFilePath: path.join(sessionDir, "ratelimit.json"),
    // With many accounts a low global cap would let one noisy client lock
    // everybody out; per-client and per-account limits do the real work.
    globalMaxAttempts: 1000,
  });

  const google = authConfig.google ? createGoogleOAuth(authConfig.google) : null;
  console.log(
    `[auth] Sign-in methods: password${emailSender ? `, email code (${emailSender.name})` : ""}${
      smsSender ? `, phone code (${smsSender.name})` : ""
    }${google ? ", Google" : ""}. Sign-up: ${authConfig.signup.mode}${
      authConfig.signup.allowlist.length ? " (allowlist)" : ""
    }. Accounts: ${userStore.count()}.`,
  );

  let isShuttingDown = false;
  const cloudBinDir = ensureCloudCliBin(path.join(DATA_ROOT, ".career-ops-bin"));
  const workerPath = [process.env.PATH, cloudBinDir].filter(Boolean).join(path.delimiter);

  // 3. One Next.js process per account, started on demand
  async function startAppProcess({ key, root }) {
    const port = await findFreePort();
    const isOwner = key === OWNER_ACCOUNT_ID;
    console.log(`[supervisor] Starting app process for ${key} on 127.0.0.1:${port}...`);
    const proc = spawn(process.execPath, [nextBinPath, "start", "-p", String(port), "-H", "127.0.0.1"], {
      cwd: webDir,
      env: buildWorkerEnv(process.env, {
        isOwner,
        shareAiKeys: authConfig.shareAiKeys,
        overrides: {
          PORT: String(port),
          HOSTNAME: "127.0.0.1",
          PATH: workerPath,
          CAREER_OPS_ROOT: root,
          CAREER_OPS_CODE_ROOT: codeRoot,
          CAREER_OPS_WEB_ALLOWED_HOSTS: [...allowedHosts, "127.0.0.1", "localhost"].join(","),
          CAREER_OPS_GATEWAY: "1",
          NEXT_TELEMETRY_DISABLED: "1",
          NODE_ENV: IS_PRODUCTION ? "production" : "development",
        },
      }),
      stdio: "inherit",
      windowsHide: true,
    });

    const exited = new Promise((resolve) => {
      proc.once("exit", (code, signal) => resolve({ code, signal }));
      proc.once("error", (err) => resolve({ code: null, signal: null, error: err }));
    });
    exited.then(({ code, signal }) => {
      if (!isShuttingDown) console.log(`[supervisor] App process for ${key} exited (code=${code} signal=${signal}).`);
    });

    const stop = async () => {
      if (proc.exitCode !== null || proc.signalCode !== null) return;
      proc.kill("SIGTERM");
      const force = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          // already gone
        }
      }, 5000);
      await exited;
      clearTimeout(force);
    };

    try {
      await waitForPort(port, exited, 90_000);
    } catch (err) {
      await stop();
      throw err;
    }
    return { host: "127.0.0.1", port, stop, exited };
  }

  const workspaces = new WorkspaceManager({
    ownerRoot: DATA_ROOT,
    tenantsDir: path.join(DATA_ROOT, TENANTS_DIRNAME),
    startWorker: startAppProcess,
    maxWorkers: authConfig.maxWorkspaces,
    idleMs: authConfig.workspaceIdleMs,
    // A deleted account's files must also leave the bucket, or the next
    // restart would download them again.
    onWorkspaceRemoved: r2Adapter
      ? async (root) => {
          const removed = await r2Adapter.deletePrefix(path.relative(DATA_ROOT, root));
          console.log(`[storage] Removed ${removed} objects of a deleted workspace from R2.`);
        }
      : null,
  });

  // Optional PDF painter process if enabled (serves the owner workspace)
  const children = [];
  if (process.env.CAREER_OPS_ENABLE_PDF === "1") {
    const painterScript = path.join(codeRoot, "generate-pdf.mjs");
    if (fs.existsSync(painterScript)) {
      console.log("[supervisor] Starting PDF painter daemon...");
      const painter = spawn(process.execPath, [painterScript, "--pdf-server"], {
        cwd: codeRoot,
        env: buildWorkerEnv(process.env, {
          isOwner: true,
          shareAiKeys: true,
          overrides: {
            CAREER_OPS_ROOT: DATA_ROOT,
            CAREER_OPS_PDF_SHARED: "1",
            CAREER_OPS_PDF_SERVER_PROCESS: "1",
          },
        }),
        stdio: "ignore",
        windowsHide: true,
      });
      children.push({ name: "pdf-painter", proc: painter });
      painter.on("exit", (code) => {
        console.log(`[supervisor] PDF painter exited with code=${code}`);
      });
      painter.on("error", (err) => {
        console.error(`[supervisor] PDF painter failed to start: ${err.message}`);
      });
    }
  }

  // 4. Start Gateway on public port
  const gateway = createGateway({
    authStore,
    rateLimiter,
    ownerUser: AUTH_USER || "admin",
    ownerPasswordHash: AUTH_PASSWORD_HASH || "scrypt:00:00",
    ownerEmail: authConfig.ownerEmail,
    userStore,
    otpStore: new OtpStore({ secret: authConfig.secret }),
    emailSender,
    smsSender,
    google,
    signup: authConfig.signup,
    defaultCountryCode: authConfig.defaultCountryCode || "+91",
    smsHourlyCap: authConfig.smsHourlyCap,
    secret: authConfig.secret,
    publicUrl: authConfig.publicUrl,
    workspaces,
    allowedHosts,
    isCloud: IS_CLOUD,
    allowDirectFallback: true,
  });

  const gatewayServer = gateway.listen(PORT, "0.0.0.0", () => {
    console.log(`[gateway] Production Auth & Security Gateway listening on 0.0.0.0:${PORT}`);
    console.log(`[gateway] Healthcheck available at http://0.0.0.0:${PORT}/healthz`);
  });
  gatewayServer.on("error", (err) => {
    console.error(`FATAL: Gateway could not listen on port ${PORT}: ${err.message}`);
    process.exit(1);
  });

  // 5. Graceful shutdown handler
  async function shutdown(exitCode = 0) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log("[supervisor] Graceful shutdown initiated...");

    // Whatever happens below, do not outlive the platform's grace period.
    const deadline = setTimeout(() => {
      console.warn("[supervisor] Shutdown deadline reached; exiting.");
      process.exit(exitCode || 1);
    }, 25_000);
    if (deadline.unref) deadline.unref();

    // Stop accepting new gateway connections
    gatewayServer.close(() => {
      console.log("[gateway] Gateway server closed.");
    });
    if (gatewayServer.closeIdleConnections) gatewayServer.closeIdleConnections();

    for (const { name, proc } of children) {
      if (proc.exitCode === null && proc.signalCode === null) {
        console.log(`[supervisor] Sending SIGTERM to ${name} (PID ${proc.pid})...`);
        try {
          proc.kill("SIGTERM");
        } catch {
          // ignore
        }
      }
    }

    try {
      await workspaces.shutdown();
      console.log("[supervisor] All app processes stopped.");
    } catch (err) {
      console.error(`[supervisor] Error stopping app processes: ${err.message}`);
    }

    // Flush R2 storage after the app processes have stopped writing
    if (r2Adapter) {
      try {
        console.log("[supervisor] Flushing R2 storage on shutdown...");
        await r2Adapter.flush();
        console.log("[supervisor] R2 storage flush complete.");
      } catch (err) {
        console.error(`[r2-storage] Flush error on shutdown: ${err.message}`);
      }
    }

    console.log("[supervisor] Storage synchronized. Exiting cleanly.");
    process.exit(exitCode);
  }

  process.on("SIGTERM", () => {
    console.log("[supervisor] Received SIGTERM");
    shutdown(0);
  });

  process.on("SIGINT", () => {
    console.log("[supervisor] Received SIGINT");
    shutdown(0);
  });

  process.on("message", (msg) => {
    if (msg === "shutdown" || msg?.type === "shutdown") {
      console.log("[supervisor] Received shutdown message via IPC");
      shutdown(0);
    }
  });
}

main().catch((err) => {
  console.error(`FATAL: Unhandled error in supervisor: ${err.message}`);
  process.exit(1);
});

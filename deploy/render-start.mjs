#!/usr/bin/env node
/**
 * deploy/render-start.mjs
 * Production entrypoint and supervisor for Career Ops on Render.
 *
 * Responsibilities:
 * 1. Validate environment (auth user, password hash, session secret).
 * 2. Validate persistent storage (/var/data/career-ops): ensures mount is present and writable.
 * 3. Seed initial user directory structure if first run on fresh volume.
 * 4. Start Next.js on an internal loopback port (127.0.0.1).
 * 5. Start the Auth & Security Gateway on 0.0.0.0:$PORT.
 * 6. Handle SIGTERM / SIGINT gracefully: forward signals, drain, reap child processes.
 * 7. Monitor child processes and fail closed if Next.js crashes.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { AuthStore } from "./auth-store.mjs";
import { LoginRateLimiter } from "./rate-limiter.mjs";
import { createGateway } from "./gateway.mjs";
import { verifyPersistentStorage } from "./storage-check.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const codeRoot = path.resolve(__dirname, "..");
const webDir = path.join(codeRoot, "web");

// 1. Environment validation
const PORT = parseInt(process.env.PORT || "3000", 10);
const AUTH_USER = process.env.CAREER_OPS_AUTH_USER?.trim();
const AUTH_PASSWORD_HASH = process.env.CAREER_OPS_AUTH_PASSWORD_HASH?.trim();
const DATA_ROOT = process.env.CAREER_OPS_ROOT?.trim() || "/var/data/career-ops";
const IS_PRODUCTION = process.env.NODE_ENV === "production";
const IS_CLOUD = process.env.CAREER_OPS_CLOUD === "1" || Boolean(process.env.RENDER);

console.log("==================================================");
console.log("Career Ops Production Supervisor Starting");
console.log(`Port: ${PORT}`);
console.log(`Data Root: ${DATA_ROOT}`);
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

// 2. Storage validation (Requirement 4)
try {
  verifyPersistentStorage(DATA_ROOT);
  console.log(`[storage] Verified persistent storage at ${DATA_ROOT}`);
} catch (err) {
  console.error(`FATAL: Storage verification failed: ${err.message}`);
  console.error("Ensure that the persistent disk is mounted and writable.");
  process.exit(1);
}

// 3. Find an available internal port for Next.js (loopback only)
async function findFreePort(startPort = 3001) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(startPort, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on("error", () => {
      // If busy, try next port
      resolve(findFreePort(startPort + 1));
    });
  });
}

async function main() {
  const internalPort = await findFreePort(PORT + 1);
  console.log(`[supervisor] Next.js internal port: ${internalPort}`);

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

  // Allowed hosts setup
  const allowedHosts = [
    process.env.RENDER_EXTERNAL_HOSTNAME,
    ...(process.env.CAREER_OPS_WEB_ALLOWED_HOSTS || "").split(/[\s,]+/),
  ].filter(Boolean);

  // Initialize Auth Store
  const sessionDir = process.env.CAREER_OPS_SESSION_DIR || path.join(DATA_ROOT, ".sessions");
  const authStore = new AuthStore({ sessionDir });
  const rateLimiter = new LoginRateLimiter();

  // Child processes tracking
  const children = [];
  let isShuttingDown = false;

  // 4. Start Next.js child process
  console.log(`[supervisor] Spawning Next.js on 127.0.0.1:${internalPort}...`);
  const nextEnv = {
    ...process.env,
    PORT: String(internalPort),
    HOSTNAME: "127.0.0.1",
    CAREER_OPS_ROOT: DATA_ROOT,
    CAREER_OPS_CODE_ROOT: codeRoot,
    CAREER_OPS_WEB_ALLOWED_HOSTS: [...allowedHosts, "127.0.0.1", "localhost"].join(","),
    NEXT_TELEMETRY_DISABLED: "1",
    NODE_ENV: IS_PRODUCTION ? "production" : "development",
  };

  const nextProcess = spawn(process.execPath, [nextBinPath, "start", "-p", String(internalPort), "-H", "127.0.0.1"], {
    cwd: webDir,
    env: nextEnv,
    stdio: "inherit",
    windowsHide: true,
  });

  children.push({ name: "next", proc: nextProcess });

  nextProcess.on("exit", (code, signal) => {
    console.log(`[supervisor] Next.js process exited with code=${code} signal=${signal}`);
    if (!isShuttingDown) {
      console.error("FATAL: Next.js process died unexpectedly. Initiating shutdown.");
      shutdown(code || 1);
    }
  });

  // Optional PDF painter process if enabled
  if (process.env.CAREER_OPS_ENABLE_PDF === "1") {
    const painterScript = path.join(codeRoot, "generate-pdf.mjs");
    if (fs.existsSync(painterScript)) {
      console.log("[supervisor] Starting PDF painter daemon...");
      const painter = spawn(process.execPath, [painterScript, "--pdf-server"], {
        cwd: codeRoot,
        env: {
          ...process.env,
          CAREER_OPS_ROOT: DATA_ROOT,
          CAREER_OPS_PDF_SHARED: "1",
          CAREER_OPS_PDF_SERVER_PROCESS: "1",
        },
        stdio: "ignore",
        windowsHide: true,
      });
      children.push({ name: "pdf-painter", proc: painter });
      painter.on("exit", (code) => {
        console.log(`[supervisor] PDF painter exited with code=${code}`);
      });
    }
  }

  // 5. Start Gateway on public port
  const gateway = createGateway({
    authStore,
    rateLimiter,
    ownerUser: AUTH_USER || "admin",
    ownerPasswordHash: AUTH_PASSWORD_HASH || "scrypt:00:00",
    upstreamHost: "127.0.0.1",
    upstreamPort: internalPort,
    allowedHosts,
    isCloud: IS_CLOUD,
  });

  const gatewayServer = gateway.listen(PORT, "0.0.0.0", () => {
    console.log(`[gateway] Production Auth & Security Gateway listening on 0.0.0.0:${PORT}`);
    console.log(`[gateway] Healthcheck available at http://0.0.0.0:${PORT}/healthz`);
  });

  // 6. Graceful shutdown handler
  function shutdown(exitCode = 0) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log("[supervisor] Graceful shutdown initiated...");

    // Stop accepting new gateway connections
    gatewayServer.close(() => {
      console.log("[gateway] Gateway server closed.");
    });

    // Send SIGTERM to children
    for (const { name, proc } of children) {
      if (proc && !proc.killed) {
        console.log(`[supervisor] Sending SIGTERM to ${name} (PID ${proc.pid})...`);
        try {
          proc.kill("SIGTERM");
        } catch {
          // ignore
        }
      }
    }

    // Force kill if not exited within 8 seconds
    const killTimeout = setTimeout(() => {
      console.warn("[supervisor] Force killing remaining children with SIGKILL...");
      for (const { name, proc } of children) {
        if (proc && !proc.killed) {
          try {
            proc.kill("SIGKILL");
          } catch {
            // ignore
          }
        }
      }
      process.exit(exitCode || 1);
    }, 8000);

    if (killTimeout.unref) killTimeout.unref();

    // Check when all children exit
    const checkInterval = setInterval(() => {
      const alive = children.some(({ proc }) => proc && !proc.killed && proc.exitCode === null);
      if (!alive) {
        clearInterval(checkInterval);
        clearTimeout(killTimeout);
        console.log("[supervisor] All child processes reaped. Exiting cleanly.");
        process.exit(exitCode);
      }
    }, 200);
    if (checkInterval.unref) checkInterval.unref();
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

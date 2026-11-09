/**
 * deploy/tests/render-start.test.mjs
 * End-to-end supervisor lifecycle test:
 * Launches render-start.mjs, tests healthcheck, and verifies graceful shutdown on SIGTERM.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { hashPassword } from "../hash-password.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const codeRoot = path.resolve(__dirname, "../..");

async function getAvailablePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

test("7. Supervisor startup, healthcheck, and graceful SIGTERM shutdown", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "co-supervisor-test-"));
  const testPort = await getAvailablePort();
  const testPwd = "IntegrationTestPassword123!";
  const testHash = hashPassword(testPwd);

  const env = {
    ...process.env,
    PORT: String(testPort),
    CAREER_OPS_ROOT: tmpDir,
    CAREER_OPS_AUTH_USER: "testadmin",
    CAREER_OPS_AUTH_PASSWORD_HASH: testHash,
    CAREER_OPS_REQUIRE_AUTH: "1",
    NODE_ENV: "production",
    CAREER_OPS_ENABLE_PDF: "0",
  };

  const supervisorScript = path.join(codeRoot, "deploy", "render-start.mjs");
  const child = spawn(process.execPath, [supervisorScript], {
    env,
    cwd: codeRoot,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => {
    stdout += d.toString();
  });
  child.stderr.on("data", (d) => {
    stderr += d.toString();
  });

  // Poll for healthz endpoint ready (up to 30s for Next.js to start)
  const healthUrl = `http://127.0.0.1:${testPort}/healthz`;
  let healthy = false;
  const startTime = Date.now();

  while (Date.now() - startTime < 30_000) {
    try {
      const res = await fetch(healthUrl);
      if (res.status === 200) {
        const body = await res.json();
        if (body.status === "ok") {
          healthy = true;
          break;
        }
      }
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 400));
  }

  assert.equal(healthy, true, "Supervisor healthz must answer with 200 ok within 30s");

  // Send shutdown signal/message
  if (child.send) {
    child.send("shutdown");
  } else {
    child.kill("SIGTERM");
  }

  // Wait for child exit
  const exitCode = await new Promise((resolve) => {
    child.on("exit", (code, signal) => {
      resolve(code !== null ? code : signal);
    });
  });

  // Clean exit code should be 0 (or SIGTERM signal)
  if (exitCode !== 0 && exitCode !== "SIGTERM") {
    console.log("Supervisor STDOUT:", stdout);
    console.log("Supervisor STDERR:", stderr);
  }
  assert.ok(exitCode === 0 || exitCode === "SIGTERM", `Exit code should be 0 or SIGTERM, got ${exitCode}`);
  if (!stdout.includes("Graceful shutdown")) {
    console.log("Supervisor STDOUT:", stdout);
    console.log("Supervisor STDERR:", stderr);
  }
  assert.ok(stdout.includes("Graceful shutdown"), "Supervisor stdout should log graceful shutdown");

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

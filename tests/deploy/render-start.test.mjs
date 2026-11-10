/**
 * tests/deploy/render-start.test.mjs
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
import { hashPassword } from "../../deploy/hash-password.mjs";
import { ensureCloudCliBin, convertCvSourceToMarkdown } from "../../deploy/cloud-cli-shim.mjs";
import { spawnHeadlessCli } from "../../web/src/lib/spawn-cli.mjs";
import { scopeFrom } from "../../web/src/lib/claude-invocation.mjs";
import { CAPS } from "../../web/src/lib/worker-capabilities.mjs";
import { cvOutputReader } from "../../web/src/lib/cv/ingest-output.mjs";
import { cvReadiness } from "../../web/src/lib/cv/readiness.mjs";

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

test("8. Cloud CLI shim converts extracted PDF and LaTeX CV text via spawnHeadlessCli + cvOutputReader", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "co-cli-shim-test-"));
  const binDir = ensureCloudCliBin(path.join(tmpDir, ".career-ops-bin"));
  const binPath = path.join(binDir, process.platform === "win32" ? "claude.cmd" : "claude");
  assert.ok(fs.existsSync(binPath), "ensureCloudCliBin must create the claude shim in binDir");

  const samplePdfText = [
    "Priya Sharma",
    "Bengaluru, India | priya.sharma@example.com | +91 98765 43210 | linkedin.com/in/priyasharma | github.com/priyasharma",
    "Professional Summary",
    "Senior Full Stack Engineer with 5+ years building cloud-native web applications in React, Next.js, Node.js, and Python.",
    "Work Experience",
    "Acme Cloud Technologies -- Bengaluru",
    "Senior Software Engineer",
    "2021 - Present",
    "• Built multi-tenant authentication and reduced p95 API latency by 42%.",
    "• Led migration of 18 microservices to Node.js and PostgreSQL.",
    "Education",
    "B.Tech in Computer Science, IIT Delhi (2021)",
    "Skills",
    "JavaScript, TypeScript, React, Next.js, Node.js, Python, PostgreSQL, Docker, AWS",
  ].join("\n");

  const converted = convertCvSourceToMarkdown(samplePdfText);
  assert.match(converted.markdown, /^# CV -- Priya Sharma/m);
  assert.equal(cvReadiness(converted.markdown).scoreable, true);
  assert.ok(converted.seed.roles.length >= 1);

  const advisorScope = scopeFrom("Read,Glob,Grep");
  const prompt = `Emit ONLY the markdown between <<cv:start>> and <<cv:end>>, then <<cv:seed>>{...}.\n\nSOURCE (the user's CV text or LaTeX source — convert it):\n"""\n${samplePdfText}\n"""`;
  const args = [
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-mode",
    "acceptEdits",
    "--strict-mcp-config",
    "--allowedTools",
    advisorScope.allowed,
    "--disallowedTools",
    advisorScope.disallowed,
  ];

  let streamed = "";
  const reader = cvOutputReader({
    cliId: "claude",
    onText: (chunk) => {
      streamed += chunk;
    },
  });

  const child = spawnHeadlessCli(
    binPath,
    args,
    { cwd: tmpDir, env: process.env },
    { cliId: "claude", capabilities: CAPS.localReadOnly },
  );

  const exitCode = await new Promise((resolve, reject) => {
    child.stdout.on("data", (d) => reader.stdout(d));
    child.stderr.on("data", (d) => reader.stderr(d));
    child.on("error", reject);
    child.on("close", (code) => resolve(code));
  });

  assert.equal(exitCode, 0);
  assert.equal(reader.finish(exitCode), null);
  assert.ok(streamed.includes("<<cv:start>>"), "stream must include <<cv:start>>");
  assert.ok(streamed.includes("<<cv:end>>"), "stream must include <<cv:end>>");
  assert.ok(streamed.includes("<<cv:seed>>"), "stream must include <<cv:seed>>");
  assert.ok(streamed.includes("Priya Sharma"), "stream must preserve candidate name");
  assert.ok(streamed.includes("42%"), "stream must preserve CV metrics");

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * deploy/tests/r2-storage.test.mjs
 * Comprehensive unit and integration test suite for Cloudflare R2 client,
 * R2 storage adapter, and persistent rate limiting.
 */

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { R2Client } from "../r2-client.mjs";
import { R2StorageAdapter } from "../r2-storage-adapter.mjs";
import { LoginRateLimiter } from "../rate-limiter.mjs";
import { migrateDataToR2 } from "../r2-migrate.mjs";

test("R2Client: SigV4 signing, PUT, GET, LIST, DELETE with mock S3 server", async (t) => {
  const objects = new Map();
  let receivedAuthHeaders = [];

  // Start mock S3 server
  const server = http.createServer((req, res) => {
    receivedAuthHeaders.push(req.headers["authorization"] || "");
    const url = new URL(req.url, `http://${req.headers.host}`);
    const key = url.pathname.replace(/^\/test-bucket\/?/, "");

    // List objects (v2)
    if (url.searchParams.get("list-type") === "2") {
      let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">\n';
      xml += "  <Name>test-bucket</Name>\n";
      xml += "  <IsTruncated>false</IsTruncated>\n";
      xml += `  <KeyCount>${objects.size}</KeyCount>\n`;
      for (const [k, v] of objects.entries()) {
        xml += "  <Contents>\n";
        xml += `    <Key>${k}</Key>\n`;
        xml += `    <Size>${v.data.length}</Size>\n`;
        xml += `    <ETag>"${v.etag}"</ETag>\n`;
        xml += "    <LastModified>2026-11-09T12:00:00.000Z</LastModified>\n";
        xml += "  </Contents>\n";
      }
      xml += "</ListBucketResult>";
      res.writeHead(200, { "Content-Type": "application/xml" });
      res.end(xml);
      return;
    }

    if (req.method === "PUT") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        const etag = `etag-${Date.now()}`;
        objects.set(key, { data: body, contentType: req.headers["content-type"], etag });
        res.writeHead(200, { ETag: `"${etag}"` });
        res.end();
      });
      return;
    }

    if (req.method === "GET") {
      if (objects.has(key)) {
        const obj = objects.get(key);
        res.writeHead(200, { "Content-Type": obj.contentType, ETag: `"${obj.etag}"` });
        res.end(obj.data);
      } else {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found");
      }
      return;
    }

    if (req.method === "HEAD") {
      if (objects.has(key)) {
        const obj = objects.get(key);
        res.writeHead(200, {
          "Content-Type": obj.contentType,
          "Content-Length": String(obj.data.length),
          ETag: `"${obj.etag}"`,
        });
        res.end();
      } else {
        res.writeHead(404);
        res.end();
      }
      return;
    }

    if (req.method === "DELETE") {
      objects.delete(key);
      res.writeHead(204);
      res.end();
      return;
    }

    res.writeHead(400);
    res.end("Bad Request");
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const mockEndpoint = `http://127.0.0.1:${port}`;

  const client = new R2Client({
    accountId: "fake-account",
    accessKeyId: "FAKEACCESSKEYID12345",
    secretAccessKey: "FAKESECRETACCESSKEY67890FAKESECRETKEY",
    bucketName: "test-bucket",
    endpoint: mockEndpoint,
  });

  try {
    // 1. Put Object
    const putRes = await client.putObject("test-doc.md", "# Hello World", { contentType: "text/markdown" });
    assert.equal(putRes.ok, true);
    assert.match(putRes.etag, /^etag-/);

    // Verify SigV4 header was sent
    assert.ok(receivedAuthHeaders.length > 0);
    assert.match(receivedAuthHeaders[0], /^AWS4-HMAC-SHA256 Credential=FAKEACCESSKEYID12345\//);

    // 2. Get Object
    const getRes = await client.getObject("test-doc.md");
    assert.equal(getRes.ok, true);
    assert.equal(getRes.data.toString("utf8"), "# Hello World");

    // 3. Head Object
    const headRes = await client.headObject("test-doc.md");
    assert.equal(headRes.exists, true);
    assert.equal(headRes.size, 13);

    // 4. List Objects
    const listRes = await client.listObjects();
    assert.equal(listRes.keys.length, 1);
    assert.equal(listRes.keys[0].key, "test-doc.md");
    assert.equal(listRes.keys[0].size, 13);

    // 5. Delete Object
    const delRes = await client.deleteObject("test-doc.md");
    assert.equal(delRes.ok, true);

    const afterDel = await client.getObject("test-doc.md");
    assert.equal(afterDel.ok, false);
    assert.equal(afterDel.status, 404);
  } finally {
    server.close();
  }
});

test("R2StorageAdapter: Hydration, Write-Through, and Flush", async () => {
  const objects = new Map();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const key = url.pathname.replace(/^\/test-bucket\/?/, "");

    if (url.searchParams.get("list-type") === "2") {
      let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">\n';
      xml += "  <Name>test-bucket</Name>\n  <IsTruncated>false</IsTruncated>\n";
      for (const [k, v] of objects.entries()) {
        xml += "  <Contents>\n";
        xml += `    <Key>${k}</Key>\n`;
        xml += `    <Size>${v.data.length}</Size>\n`;
        xml += `    <ETag>"${v.etag}"</ETag>\n`;
        xml += "  </Contents>\n";
      }
      xml += "</ListBucketResult>";
      res.writeHead(200, { "Content-Type": "application/xml" });
      res.end(xml);
      return;
    }

    if (req.method === "PUT") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        const etag = `mock-etag-${Date.now()}`;
        objects.set(key, { data: body, etag });
        res.writeHead(200, { ETag: `"${etag}"` });
        res.end();
      });
      return;
    }

    if (req.method === "GET") {
      if (objects.has(key)) {
        res.writeHead(200);
        res.end(objects.get(key).data);
      } else {
        res.writeHead(404);
        res.end("Not Found");
      }
      return;
    }

    if (req.method === "DELETE") {
      objects.delete(key);
      res.writeHead(204);
      res.end();
      return;
    }

    res.writeHead(200);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const mockEndpoint = `http://127.0.0.1:${port}`;

  // Seed remote bucket with initial state
  objects.set("data/applications.md", { data: Buffer.from("# Applications\n| Company | Status |"), etag: "e1" });
  objects.set("config/profile.yml", { data: Buffer.from("name: Test Candidate"), etag: "e2" });
  objects.set("cv.md", { data: Buffer.from("# Candidate CV"), etag: "e3" });

  const tempLocalDir = path.join(os.tmpdir(), `r2-test-${Date.now()}`);
  fs.mkdirSync(tempLocalDir, { recursive: true });

  const client = new R2Client({
    accountId: "fake-acc",
    accessKeyId: "KEYID123",
    secretAccessKey: "SECRETKEY456",
    bucketName: "test-bucket",
    endpoint: mockEndpoint,
  });

  const adapter = new R2StorageAdapter({
    client,
    localDataRoot: tempLocalDir,
  });

  try {
    // 1. Hydrate from R2
    const hyd = await adapter.hydrateFromR2();
    assert.equal(hyd.downloaded, 3);
    assert.equal(hyd.errors.length, 0);

    // Verify local files exist
    assert.ok(fs.existsSync(path.join(tempLocalDir, "data", "applications.md")));
    assert.ok(fs.existsSync(path.join(tempLocalDir, "config", "profile.yml")));
    assert.ok(fs.existsSync(path.join(tempLocalDir, "cv.md")));

    // 2. Write-Through a new report
    await adapter.writeFile("reports/report-1.md", "# Analysis for ACME Corp");
    assert.ok(fs.existsSync(path.join(tempLocalDir, "reports", "report-1.md")));
    assert.ok(objects.has("reports/report-1.md"));
    assert.equal(objects.get("reports/report-1.md").data.toString("utf8"), "# Analysis for ACME Corp");

    // 3. Local file update and flush
    const newFile = path.join(tempLocalDir, "data", "salary-observations.tsv");
    fs.writeFileSync(newFile, "date\tcompany\tsalary\n");
    await adapter.flush();

    // Verify flushed to mock R2
    assert.ok(objects.has("data/salary-observations.tsv"));
    assert.equal(objects.get("data/salary-observations.tsv").data.toString("utf8"), "date\tcompany\tsalary\n");
  } finally {
    server.close();
    try {
      fs.rmSync(tempLocalDir, { recursive: true, force: true });
    } catch {}
  }
});

test("LoginRateLimiter: State persistence and lockout preservation", async () => {
  const tempStateFile = path.join(os.tmpdir(), `ratelimit-test-${Date.now()}.json`);

  const limiter1 = new LoginRateLimiter({
    maxAttempts: 3,
    windowMs: 60000,
    lockoutMs: 60000,
    stateFilePath: tempStateFile,
  });

  const testIp = "192.168.1.100";
  limiter1.recordFailure(testIp);
  limiter1.recordFailure(testIp);
  limiter1.recordFailure(testIp); // Reaches maxAttempts -> locked out

  const check1 = limiter1.check(testIp);
  assert.equal(check1.allowed, false);
  assert.ok(check1.retryAfterSeconds > 0);
  limiter1.destroy();

  // Verify file was written
  assert.ok(fs.existsSync(tempStateFile));

  // Instantiate new limiter reading from same state file
  const limiter2 = new LoginRateLimiter({
    maxAttempts: 3,
    windowMs: 60000,
    lockoutMs: 60000,
    stateFilePath: tempStateFile,
  });

  // Lockout must persist!
  const check2 = limiter2.check(testIp);
  assert.equal(check2.allowed, false);
  assert.ok(check2.retryAfterSeconds > 0);

  // Success resets state
  limiter2.recordSuccess(testIp);
  const check3 = limiter2.check(testIp);
  assert.equal(check3.allowed, true);

  limiter2.destroy();
  try {
    fs.unlinkSync(tempStateFile);
  } catch {}
});

test("migrateDataToR2: Collects user data, hashes, uploads, and generates manifest", async () => {
  const objects = new Map();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const key = url.pathname.replace(/^\/test-bucket\/?/, "");

    if (req.method === "PUT") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        objects.set(key, { data: body, etag: `hash-${Date.now()}` });
        res.writeHead(200, { ETag: `"mock-etag"` });
        res.end();
      });
      return;
    }

    if (req.method === "HEAD") {
      if (objects.has(key)) {
        res.writeHead(200, {
          "Content-Length": String(objects.get(key).data.length),
          ETag: `"${objects.get(key).etag}"`,
        });
        res.end();
      } else {
        res.writeHead(404);
        res.end();
      }
      return;
    }

    res.writeHead(200);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const mockEndpoint = `http://127.0.0.1:${port}`;

  const tempSourceDir = path.join(os.tmpdir(), `migrate-source-${Date.now()}`);
  fs.mkdirSync(path.join(tempSourceDir, "data"), { recursive: true });
  fs.mkdirSync(path.join(tempSourceDir, "config"), { recursive: true });

  fs.writeFileSync(path.join(tempSourceDir, "cv.md"), "# Candidate CV Content\n");
  fs.writeFileSync(path.join(tempSourceDir, "data", "applications.md"), "# Application Tracker\n");
  fs.writeFileSync(path.join(tempSourceDir, "config", "profile.yml"), "name: John Doe\n");

  const client = new R2Client({
    accountId: "fake-acc",
    accessKeyId: "KEY123",
    secretAccessKey: "SEC456",
    bucketName: "test-bucket",
    endpoint: mockEndpoint,
  });

  try {
    const result = await migrateDataToR2({ client, sourceDir: tempSourceDir });
    assert.equal(result.ok, true);
    assert.equal(result.manifest.totalFiles, 3);
    assert.ok(result.manifest.totalBytes > 0);

    // Verify objects were uploaded
    assert.ok(objects.has("cv.md"));
    assert.ok(objects.has("data/applications.md"));
    assert.ok(objects.has("config/profile.yml"));
    assert.ok(objects.has("migration-manifest.json"));

    // Check manifest contents
    const manifestParsed = JSON.parse(objects.get("migration-manifest.json").data.toString("utf8"));
    assert.equal(manifestParsed.totalFiles, 3);
    assert.equal(manifestParsed.files.length, 3);
    assert.equal(manifestParsed.files[0].verified, true);
  } finally {
    server.close();
    try {
      fs.rmSync(tempSourceDir, { recursive: true, force: true });
    } catch {}
  }
});

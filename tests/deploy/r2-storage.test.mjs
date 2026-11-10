/**
 * tests/deploy/r2-storage.test.mjs
 * Comprehensive unit and integration test suite for Cloudflare R2 client,
 * R2 storage adapter, and persistent rate limiting.
 */

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { R2Client } from "../../deploy/r2-client.mjs";
import { R2StorageAdapter } from "../../deploy/r2-storage-adapter.mjs";
import { LoginRateLimiter } from "../../deploy/rate-limiter.mjs";
import { migrateDataToR2 } from "../../deploy/r2-migrate.mjs";

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

/**
 * A mock S3 endpoint that pages its listings, honours `prefix`, and records
 * every request. `pageSize` is deliberately tiny so pagination is exercised
 * with a handful of objects.
 */
async function startPagingBucket({ pageSize = 2 } = {}) {
  const objects = new Map();
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const key = decodeURIComponent(url.pathname.replace(/^\/test-bucket\/?/, ""));
    requests.push({ method: req.method, key, query: Object.fromEntries(url.searchParams) });

    if (url.searchParams.get("list-type") === "2") {
      const prefix = url.searchParams.get("prefix") || "";
      const all = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = Number(url.searchParams.get("continuation-token") || 0);
      const page = all.slice(start, start + pageSize);
      const more = start + pageSize < all.length;
      let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<ListBucketResult>\n';
      xml += `  <IsTruncated>${more}</IsTruncated>\n`;
      if (more) xml += `  <NextContinuationToken>${start + pageSize}</NextContinuationToken>\n`;
      for (const k of page) {
        xml += `  <Contents><Key>${k}</Key><Size>${objects.get(k).length}</Size><ETag>"e"</ETag></Contents>\n`;
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
        objects.set(key, Buffer.concat(chunks));
        res.writeHead(200, { ETag: '"e"' });
        res.end();
      });
      return;
    }
    if (req.method === "GET") {
      if (!objects.has(key)) {
        res.writeHead(404);
        res.end("Not Found");
        return;
      }
      res.writeHead(200);
      res.end(objects.get(key));
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
  const client = new R2Client({
    accountId: "fake-acc",
    accessKeyId: "KEYID123",
    secretAccessKey: "SECRETKEY456",
    bucketName: "test-bucket",
    endpoint: `http://127.0.0.1:${server.address().port}`,
  });
  return { server, objects, requests, client };
}

test("R2: a listing longer than one page is hydrated in full", async () => {
  const { server, objects, requests, client } = await startPagingBucket({ pageSize: 2 });
  const localDir = fs.mkdtempSync(path.join(os.tmpdir(), "r2-paging-"));
  try {
    for (let i = 1; i <= 5; i++) objects.set(`reports/00${i}-acme.md`, Buffer.from(`report ${i}`));

    const listed = await client.listAllObjects();
    assert.equal(listed.length, 5, "every page is followed, not just the first");
    assert.equal(requests.filter((r) => r.query["list-type"] === "2").length, 3, "5 objects at 2 per page is 3 listing calls");

    const adapter = new R2StorageAdapter({ client, localDataRoot: localDir });
    const hyd = await adapter.hydrateFromR2();
    assert.equal(hyd.downloaded, 5);
    for (let i = 1; i <= 5; i++) {
      assert.equal(fs.readFileSync(path.join(localDir, "reports", `00${i}-acme.md`), "utf8"), `report ${i}`);
    }
  } finally {
    server.close();
    fs.rmSync(localDir, { recursive: true, force: true });
  }
});

test("R2: file names with #, ?, spaces and + round-trip to the same key", async () => {
  const { server, objects, requests, client } = await startPagingBucket({ pageSize: 50 });
  try {
    const names = ["output/C# developer (v2).pdf", "jds/what? why.md", "reports/a+b & c's.md", "data/100%.tsv"];
    for (const name of names) {
      await client.putObject(name, Buffer.from(name));
      assert.ok(objects.has(name), `"${name}" must be stored under its own name`);
      const got = await client.getObject(name);
      assert.equal(got.data.toString("utf8"), name);
    }
    assert.equal(objects.size, names.length, "no name was truncated into another key");

    // A prefix with a space is sent as %20, the same bytes that were signed.
    await client.listObjects({ prefix: "jds/what? why" });
    const listing = requests.at(-1);
    assert.equal(listing.query.prefix, "jds/what? why");

    for (const name of names) await client.deleteObject(name);
    assert.equal(objects.size, 0);
  } finally {
    server.close();
  }
});

test("R2: an object key cannot write outside the data root during hydration", async () => {
  const { server, objects, client } = await startPagingBucket({ pageSize: 50 });
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "r2-escape-"));
  const localDir = path.join(parent, "data-root");
  fs.mkdirSync(localDir);
  try {
    objects.set("../escaped.txt", Buffer.from("should never land beside the data root"));
    objects.set("cv.md", Buffer.from("# CV"));

    const adapter = new R2StorageAdapter({ client, localDataRoot: localDir });
    const hyd = await adapter.hydrateFromR2();
    assert.equal(fs.existsSync(path.join(parent, "escaped.txt")), false);
    assert.equal(hyd.errors.length, 1, "the hostile key is reported, not followed");
    assert.equal(fs.readFileSync(path.join(localDir, "cv.md"), "utf8"), "# CV", "the rest still hydrates");
  } finally {
    server.close();
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("R2: a flush sends queued deletes, so deleted files do not come back", async () => {
  const { server, objects, client } = await startPagingBucket({ pageSize: 50 });
  const localDir = fs.mkdtempSync(path.join(os.tmpdir(), "r2-flush-"));
  try {
    objects.set("jds/old-posting.md", Buffer.from("stale"));
    const adapter = new R2StorageAdapter({ client, localDataRoot: localDir });

    // What the watcher queues when a file is removed locally just before shutdown.
    adapter.pendingSyncs.set(path.join("jds", "old-posting.md"), { type: "delete" });
    await adapter.flush();

    assert.equal(objects.has("jds/old-posting.md"), false, "the delete reached the bucket");
    assert.equal(adapter.pendingSyncs.size, 0);
  } finally {
    server.close();
    fs.rmSync(localDir, { recursive: true, force: true });
  }
});

test("R2: deleting a workspace removes its objects and nothing else", async () => {
  const { server, objects, client } = await startPagingBucket({ pageSize: 2 });
  const localDir = fs.mkdtempSync(path.join(os.tmpdir(), "r2-prefix-"));
  try {
    const mine = ".tenants/u_aaaaaaaaaaaaaaaa";
    for (const name of ["cv.md", "data/applications.md", "reports/001-acme.md"]) {
      objects.set(`${mine}/${name}`, Buffer.from("a"));
    }
    // A sibling whose id merely starts with the same characters, and the owner's files.
    objects.set(".tenants/u_aaaaaaaaaaaaaaaa1/cv.md", Buffer.from("sibling"));
    objects.set(".tenants/u_bbbbbbbbbbbbbbbb/cv.md", Buffer.from("b"));
    objects.set("cv.md", Buffer.from("owner"));

    const adapter = new R2StorageAdapter({ client, localDataRoot: localDir });
    const removed = await adapter.deletePrefix(path.join(".tenants", "u_aaaaaaaaaaaaaaaa"));

    assert.equal(removed, 3);
    assert.deepEqual([...objects.keys()].sort(), [
      ".tenants/u_aaaaaaaaaaaaaaaa1/cv.md",
      ".tenants/u_bbbbbbbbbbbbbbbb/cv.md",
      "cv.md",
    ]);
    // An empty prefix would match the whole bucket.
    await assert.rejects(adapter.deletePrefix(""), /non-empty/);
    await assert.rejects(adapter.deletePrefix("../elsewhere"), /traversal/);
    assert.equal(objects.size, 3);
  } finally {
    server.close();
    fs.rmSync(localDir, { recursive: true, force: true });
  }
});

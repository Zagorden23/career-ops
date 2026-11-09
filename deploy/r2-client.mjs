/**
 * deploy/r2-client.mjs
 * Production-grade Cloudflare R2 / S3-compatible client in pure Node.js.
 *
 * Implements AWS Signature Version 4 (SigV4) for authenticated REST calls
 * to Cloudflare R2 S3 API endpoints without requiring external dependencies.
 */

import crypto from "node:crypto";

export class R2Client {
  /**
   * @param {object} options
   * @param {string} options.accountId - Cloudflare Account ID
   * @param {string} options.accessKeyId - R2 Access Key ID
   * @param {string} options.secretAccessKey - R2 Secret Access Key
   * @param {string} options.bucketName - R2 Bucket Name
   * @param {string} [options.endpoint] - Optional custom endpoint URL
   */
  constructor({ accountId, accessKeyId, secretAccessKey, bucketName, endpoint }) {
    if (!accessKeyId || !secretAccessKey) {
      throw new Error("R2Client requires accessKeyId and secretAccessKey");
    }
    if (!bucketName) {
      throw new Error("R2Client requires bucketName");
    }

    this.accountId = accountId?.trim() || "";
    this.accessKeyId = accessKeyId.trim();
    this.secretAccessKey = secretAccessKey.trim();
    this.bucketName = bucketName.trim();
    this.region = "auto";

    if (endpoint) {
      // Remove trailing slash
      this.endpoint = endpoint.replace(/\/+$/, "");
    } else if (this.accountId) {
      this.endpoint = `https://${this.accountId}.r2.cloudflarestorage.com`;
    } else {
      throw new Error("R2Client requires either accountId or endpoint");
    }
  }

  /**
   * Calculate AWS SigV4 authorization headers.
   */
  _signRequest({ method, pathname, query = {}, headers = {}, body = Buffer.alloc(0) }) {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const dateStamp = amzDate.slice(0, 8);

    const url = new URL(this.endpoint);
    const host = url.host;

    // Content SHA256
    const payloadHash = crypto.createHash("sha256").update(body).digest("hex");

    const signedHeadersList = ["host", "x-amz-content-sha256", "x-amz-date"];
    const canonicalHeadersMap = {
      host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
    };

    // Add extra headers if present
    for (const [k, v] of Object.entries(headers)) {
      const lower = k.toLowerCase();
      signedHeadersList.push(lower);
      canonicalHeadersMap[lower] = String(v).trim();
    }

    signedHeadersList.sort();

    const canonicalHeadersStr = signedHeadersList
      .map((h) => `${h}:${canonicalHeadersMap[h]}\n`)
      .join("");
    const signedHeadersStr = signedHeadersList.join(";");

    // Canonical query string
    const queryKeys = Object.keys(query).sort();
    const canonicalQueryStr = queryKeys
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k])}`)
      .join("&");

    // Canonical URI
    const canonicalUri = pathname.startsWith("/") ? pathname : `/${pathname}`;

    // Canonical Request
    const canonicalRequest = [
      method,
      canonicalUri,
      canonicalQueryStr,
      canonicalHeadersStr,
      signedHeadersStr,
      payloadHash,
    ].join("\n");

    // String to Sign
    const algorithm = "AWS4-HMAC-SHA256";
    const credentialScope = `${dateStamp}/${this.region}/s3/aws4_request`;
    const stringToSign = [
      algorithm,
      amzDate,
      credentialScope,
      crypto.createHash("sha256").update(canonicalRequest, "utf8").digest("hex"),
    ].join("\n");

    // Signing Key
    const kDate = crypto.createHmac("sha256", `AWS4${this.secretAccessKey}`).update(dateStamp).digest();
    const kRegion = crypto.createHmac("sha256", kDate).update(this.region).digest();
    const kService = crypto.createHmac("sha256", kRegion).update("s3").digest();
    const kSigning = crypto.createHmac("sha256", kService).update("aws4_request").digest();

    // Signature
    const signature = crypto.createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");

    const authorization = `${algorithm} Credential=${this.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeadersStr}, Signature=${signature}`;

    return {
      ...canonicalHeadersMap,
      authorization,
      "x-amz-date": amzDate,
      "x-amz-content-sha256": payloadHash,
    };
  }

  async _request({ method, key = "", query = {}, headers = {}, body = Buffer.alloc(0), retries = 3 }) {
    const rawPath = key ? `/${this.bucketName}/${encodeURI(key).replace(/\+/g, "%2B")}` : `/${this.bucketName}`;
    const pathname = rawPath.replace(/\/+/g, "/");

    let lastError = null;

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const signedHeaders = this._signRequest({
          method,
          pathname,
          query,
          headers,
          body,
        });

        const queryParams = new URLSearchParams(query).toString();
        const fullUrl = `${this.endpoint}${pathname}${queryParams ? `?${queryParams}` : ""}`;

        const res = await fetch(fullUrl, {
          method,
          headers: signedHeaders,
          body: method === "GET" || method === "HEAD" ? undefined : body,
        });

        return res;
      } catch (err) {
        lastError = err;
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, attempt * 300));
        }
      }
    }

    throw lastError || new Error(`R2 request failed after ${retries} retries`);
  }

  /**
   * Put an object into R2.
   * @param {string} key
   * @param {Buffer|string} content
   * @param {object} [options]
   * @param {string} [options.contentType="application/octet-stream"]
   * @param {string} [options.ifMatch]
   * @returns {Promise<{ ok: true, etag: string }>}
   */
  async putObject(key, content, { contentType = "application/octet-stream", ifMatch } = {}) {
    const body = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    const headers = { "content-type": contentType };
    if (ifMatch) headers["if-match"] = ifMatch;

    const res = await this._request({ method: "PUT", key, headers, body });
    if (!res.ok) {
      const errText = await res.text();
      const err = new Error(`R2 putObject failed (${res.status}): ${errText}`);
      err.status = res.status;
      err.code = res.status === 412 ? "PreconditionFailed" : "PutObjectError";
      throw err;
    }

    const etag = res.headers.get("etag")?.replace(/"/g, "") || "";
    return { ok: true, etag };
  }

  /**
   * Get an object from R2.
   * @param {string} key
   * @param {object} [options]
   * @param {string} [options.ifNoneMatch]
   * @returns {Promise<{ ok: boolean, data?: Buffer, etag?: string, notModified?: boolean }>}
   */
  async getObject(key, { ifNoneMatch } = {}) {
    const headers = {};
    if (ifNoneMatch) headers["if-none-match"] = ifNoneMatch;

    const res = await this._request({ method: "GET", key, headers });
    if (res.status === 304) {
      return { ok: true, notModified: true, etag: ifNoneMatch };
    }
    if (res.status === 404) {
      return { ok: false, notFound: true, status: 404 };
    }
    if (!res.ok) {
      const errText = await res.text();
      const err = new Error(`R2 getObject failed (${res.status}): ${errText}`);
      err.status = res.status;
      throw err;
    }

    const arrayBuffer = await res.arrayBuffer();
    const data = Buffer.from(arrayBuffer);
    const etag = res.headers.get("etag")?.replace(/"/g, "") || "";
    return { ok: true, data, etag, contentType: res.headers.get("content-type") };
  }

  /**
   * Check if object exists and get metadata.
   * @param {string} key
   * @returns {Promise<{ exists: boolean, size?: number, etag?: string, lastModified?: string }>}
   */
  async headObject(key) {
    const res = await this._request({ method: "HEAD", key });
    if (res.status === 404) {
      return { exists: false };
    }
    if (!res.ok) {
      const err = new Error(`R2 headObject failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    const size = parseInt(res.headers.get("content-length") || "0", 10);
    const etag = res.headers.get("etag")?.replace(/"/g, "") || "";
    const lastModified = res.headers.get("last-modified") || "";
    return { exists: true, size, etag, lastModified };
  }

  /**
   * Delete an object from R2.
   * @param {string} key
   * @returns {Promise<{ ok: true }>}
   */
  async deleteObject(key) {
    const res = await this._request({ method: "DELETE", key });
    if (!res.ok && res.status !== 404) {
      const errText = await res.text();
      const err = new Error(`R2 deleteObject failed (${res.status}): ${errText}`);
      err.status = res.status;
      throw err;
    }
    return { ok: true };
  }

  /**
   * List objects in the bucket.
   * @param {object} [options]
   * @param {string} [options.prefix=""]
   * @param {string} [options.delimiter]
   * @param {number} [options.maxKeys=1000]
   * @returns {Promise<{ keys: Array<{ key: string, size: number, lastModified: string, etag: string }>, prefixes: string[] }>}
   */
  async listObjects({ prefix = "", delimiter = "", maxKeys = 1000 } = {}) {
    const query = {
      "list-type": "2",
      "max-keys": String(maxKeys),
    };
    if (prefix) query.prefix = prefix;
    if (delimiter) query.delimiter = delimiter;

    const res = await this._request({ method: "GET", key: "", query });
    if (!res.ok) {
      const errText = await res.text();
      const err = new Error(`R2 listObjects failed (${res.status}): ${errText}`);
      err.status = res.status;
      throw err;
    }

    const xml = await res.text();
    return parseListObjectsV2Xml(xml);
  }
}

/**
 * Lightweight XML parser for S3 ListObjectsV2 response.
 */
function parseListObjectsV2Xml(xml) {
  const keys = [];
  const prefixes = [];

  // Parse <Contents>
  const contentRegex = /<Contents>([\s\S]*?)<\/Contents>/g;
  let match;
  while ((match = contentRegex.exec(xml)) !== null) {
    const block = match[1];
    const keyMatch = /<Key>(.*?)<\/Key>/.exec(block);
    const sizeMatch = /<Size>(\d+)<\/Size>/.exec(block);
    const lmMatch = /<LastModified>(.*?)<\/LastModified>/.exec(block);
    const etagMatch = /<ETag>(.*?)<\/ETag>/.exec(block);

    if (keyMatch) {
      keys.push({
        key: decodeXml(keyMatch[1]),
        size: sizeMatch ? parseInt(sizeMatch[1], 10) : 0,
        lastModified: lmMatch ? lmMatch[1] : "",
        etag: etagMatch ? etagMatch[1].replace(/"/g, "") : "",
      });
    }
  }

  // Parse <CommonPrefixes>
  const prefixRegex = /<CommonPrefixes>[\s\S]*?<Prefix>(.*?)<\/Prefix>[\s\S]*?<\/CommonPrefixes>/g;
  while ((match = prefixRegex.exec(xml)) !== null) {
    prefixes.push(decodeXml(match[1]));
  }

  return { keys, prefixes };
}

function decodeXml(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

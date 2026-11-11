#!/usr/bin/env node
/**
 * deploy/hash-password.mjs
 * Secure password hashing utility for Career Ops on Render.
 *
 * Uses Node's built-in crypto.scrypt with a cryptographically secure random salt
 * and timing-safe comparison to prevent timing attacks.
 *
 * Supports:
 * - Interactive masked terminal input (password does not appear on screen or in shell history)
 * - Confirmation prompt in interactive mode
 * - Stdin piping (e.g. for scripts or CI)
 * - Verification mode (--verify)
 */

import crypto from "node:crypto";
import readline from "node:readline";
import { isMainModule } from "../lib/is-main-module.mjs";

const SCRYPT_OPTIONS = {
  N: 16384, // CPU/memory cost
  r: 8,     // Block size
  p: 1,     // Parallelization
  maxmem: 32 * 1024 * 1024,
};

const KEY_LENGTH = 64; // 512-bit key
const SALT_LENGTH = 16; // 128-bit salt

/**
 * Hash a plaintext password.
 * @param {string} password
 * @returns {string} Formatted as `scrypt:<salt-hex>:<hash-hex>`
 */
export function hashPassword(password) {
  if (typeof password !== "string" || password.length === 0) {
    throw new Error("Password must be a non-empty string");
  }
  const salt = crypto.randomBytes(SALT_LENGTH);
  const derived = crypto.scryptSync(password, salt, KEY_LENGTH, SCRYPT_OPTIONS);
  return `scrypt:${salt.toString("hex")}:${derived.toString("hex")}`;
}

/**
 * Verify a plaintext password against a stored scrypt hash.
 * Uses timing-safe equality to prevent timing attacks.
 * @param {string} password
 * @param {string} storedHash
 * @returns {boolean}
 */
export function verifyPassword(password, storedHash) {
  if (typeof password !== "string" || typeof storedHash !== "string") {
    return false;
  }
  const parts = storedHash.split(":");
  if (parts.length !== 3 || parts[0] !== "scrypt") {
    return false;
  }
  const [, saltHex, hashHex] = parts;
  if (!saltHex || !hashHex) {
    return false;
  }
  try {
    const salt = Buffer.from(saltHex, "hex");
    const expected = Buffer.from(hashHex, "hex");
    if (salt.length !== SALT_LENGTH || expected.length !== KEY_LENGTH) {
      return false;
    }
    const derived = crypto.scryptSync(password, salt, expected.length, SCRYPT_OPTIONS);
    return crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/**
 * Securely prompt for password with masked characters in a terminal.
 * @param {string} promptText
 * @returns {Promise<string>}
 */
export function promptHidden(promptText = "Password: ") {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      // Non-interactive fallback (e.g. piped stdin)
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: false,
      });
      rl.question(promptText, (answer) => {
        rl.close();
        resolve(answer.trim());
      });
      return;
    }

    process.stdout.write(promptText);
    let pwd = "";
    const wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");

    function onData(chunk) {
      for (const char of chunk) {
        if (char === "\u0003") {
          // Ctrl+C
          process.stdin.setRawMode(wasRaw);
          process.stdin.removeListener("data", onData);
          process.stdout.write("\n");
          process.exit(130);
        } else if (char === "\r" || char === "\n") {
          // Enter key
          process.stdin.setRawMode(wasRaw);
          process.stdin.removeListener("data", onData);
          process.stdout.write("\n");
          resolve(pwd);
          return;
        } else if (char === "\u007F" || char === "\b") {
          // Backspace
          if (pwd.length > 0) {
            pwd = pwd.slice(0, -1);
            process.stdout.write("\b \b");
          }
        } else if (char.charCodeAt(0) >= 32) {
          pwd += char;
          process.stdout.write("*");
        }
      }
    }

    process.stdin.on("data", onData);
  });
}

// CLI handler
async function runCli() {
  const args = process.argv.slice(2);

  if (args[0] === "--verify" || args[0] === "-v") {
    let pwd = args[1];
    let hash = args[2];
    if (!hash && pwd && pwd.startsWith("scrypt:")) {
      hash = pwd;
      pwd = await promptHidden("Enter password to verify: ");
    } else if (!pwd || !hash) {
      console.error("Usage: node deploy/hash-password.mjs --verify <password> <hash>");
      process.exit(1);
    }
    const ok = verifyPassword(pwd, hash);
    console.log(ok ? "PASSWORD MATCHES" : "PASSWORD DOES NOT MATCH");
    process.exit(ok ? 0 : 1);
  }

  // If explicit password passed as arg (supported for backwards compatibility)
  if (args[0] && args[0] !== "-" && args[0] !== "--interactive" && args[0] !== "-i") {
    const hash = hashPassword(args[0]);
    console.log(`CAREER_OPS_AUTH_PASSWORD_HASH="${hash}"`);
    return;
  }

  // If piped input into stdin and not a TTY
  if (!process.stdin.isTTY && args[0] !== "--interactive" && args[0] !== "-i") {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      input += chunk;
    });
    process.stdin.on("end", () => {
      const password = input.replace(/[\r\n]+$/, "");
      if (!password) {
        console.error("Error: empty password received from stdin");
        process.exit(1);
      }
      const hash = hashPassword(password);
      console.log(`CAREER_OPS_AUTH_PASSWORD_HASH="${hash}"`);
    });
    return;
  }

  // Interactive mode: secure masked prompt with confirmation
  console.log("=== Career Ops Owner Password Setup ===");
  console.log("Input is masked with asterisks (*) to protect secrets from shell history.");
  console.log("");

  const pwd1 = await promptHidden("Enter owner password: ");
  if (!pwd1) {
    console.error("Error: password cannot be empty.");
    process.exit(1);
  }

  const pwd2 = await promptHidden("Confirm owner password: ");
  if (pwd1 !== pwd2) {
    console.error("Error: passwords do not match.");
    process.exit(1);
  }

  const hash = hashPassword(pwd1);
  console.log("");
  console.log("Successfully generated scrypt hash. Add this to your Render environment:");
  console.log("");
  console.log(`CAREER_OPS_AUTH_PASSWORD_HASH="${hash}"`);
  console.log("");
}

if (isMainModule(import.meta.url)) {
  runCli().catch((err) => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });
}

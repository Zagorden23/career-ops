/**
 * deploy/storage-check.mjs
 * Persistent storage validation and initialization for Career Ops on Render.
 *
 * Fails closed if the storage is missing, unmounted, or read-only.
 * Seeds standard directory layout if running on a fresh volume.
 */

import fs from "node:fs";
import path from "node:path";

export const REQUIRED_USER_DIRS = [
  "data",
  "config",
  "modes",
  "reports",
  "output",
  ".sessions",
];

/**
 * Verify persistent storage mount point and writability.
 * @param {string} dataRoot - Path to the persistent storage directory
 * @returns {{ ok: true, seededDirs: string[] }}
 * @throws {Error} if storage is unwritable or inaccessible
 */
export function verifyPersistentStorage(dataRoot) {
  if (!dataRoot || typeof dataRoot !== "string") {
    throw new Error("dataRoot must be a non-empty string path");
  }

  const resolved = path.resolve(dataRoot);

  try {
    if (!fs.existsSync(resolved)) {
      fs.mkdirSync(resolved, { recursive: true, mode: 0o750 });
    }
  } catch (err) {
    throw new Error(`Failed to access or create data root at ${resolved}: ${err.message}`);
  }

  // Write and read probe
  const probePath = path.join(resolved, `.probe-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
  try {
    const probeContent = "career-ops-storage-probe-ok\n";
    fs.writeFileSync(probePath, probeContent, { encoding: "utf8", mode: 0o600 });
    const read = fs.readFileSync(probePath, "utf8");
    fs.unlinkSync(probePath);

    if (read.trim() !== "career-ops-storage-probe-ok") {
      throw new Error("Storage probe read verification mismatch");
    }
  } catch (err) {
    throw new Error(`Storage is not writable at ${resolved}: ${err.message}`);
  }

  // Seed required directories
  const seeded = [];
  for (const dirName of REQUIRED_USER_DIRS) {
    const dirPath = path.join(resolved, dirName);
    try {
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true, mode: 0o750 });
        seeded.push(dirName);
      }
    } catch (err) {
      throw new Error(`Failed to create directory ${dirName} under ${resolved}: ${err.message}`);
    }
  }

  return { ok: true, seededDirs: seeded };
}

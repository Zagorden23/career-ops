import { randomUUID } from "node:crypto";
import { careerOpsRoot } from "@/lib/career-ops";
import { DEFAULT_FILTERS, parseExplorePatch } from "@/lib/explore";
import {
  isSafeScheduledId,
  readScheduledStore,
  withScheduledStore,
} from "./scheduled-jobs-store.mjs";
import { nextScheduledRun } from "./scheduled-cadence.mjs";
import { assertScheduledJobBody } from "./scheduled-job-input.mjs";
import { scheduledStorePath } from "./scheduled-runner-path.mjs";

export class ScheduledJobValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ScheduledJobValidationError";
  }
}

const storeFile = () => scheduledStorePath(careerOpsRoot());

function read() {
  return readScheduledStore(storeFile());
}

function cleanUnit(value, fallback) {
  if (value === undefined) return fallback;
  if (value === "minutes" || value === "hours" || value === "days") return value;
  throw new ScheduledJobValidationError("Invalid schedule unit.");
}

function cleanEvery(value, unit, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new ScheduledJobValidationError("Invalid cadence.");
  const minimum = unit === "minutes" ? 15 : 1;
  return Math.min(10_000, Math.max(minimum, Math.round(parsed)));
}

function cleanStartAt(value, fallback) {
  if (value !== undefined && typeof value !== "string" && typeof value !== "number") throw new ScheduledJobValidationError("Invalid start time.");
  const parsed = new Date(typeof value === "string" || typeof value === "number" ? value : fallback);
  if (Number.isNaN(parsed.getTime())) throw new ScheduledJobValidationError("Invalid start time.");
  return parsed.toISOString();
}

function validateTimezone(value) {
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }).format(); } catch { throw new ScheduledJobValidationError("Invalid timezone."); }
  return value;
}

export function parseScheduledJobInput(raw, base) {
  let input;
  try {
    input = assertScheduledJobBody(raw);
  } catch (error) {
    throw new ScheduledJobValidationError(error instanceof Error ? error.message : "Scheduled job body must be an object.");
  }
  const fallbackName = base?.name || "Scheduled scan";
  const name = String(input.name ?? fallbackName).trim().slice(0, 80) || fallbackName;
  if (input.engine !== undefined && input.engine !== "portals" && input.engine !== "full") throw new ScheduledJobValidationError("Invalid scan engine.");
  const engine = input.engine === "portals" || input.engine === "full" ? input.engine : base?.engine || "full";
  const unit = cleanUnit(input.unit, base?.unit || "hours");
  const every = cleanEvery(input.every, unit, base?.every || 1);
  const timezone = validateTimezone(String(input.timezone ?? base?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC")
    .trim()
    .slice(0, 80) || "UTC");
  const startAt = cleanStartAt(input.startAt, base?.startAt || new Date().toISOString());
  const filters = parseExplorePatch(
    (input.filters && typeof input.filters === "object" ? input.filters : {}),
    base?.filters || DEFAULT_FILTERS,
  );

  return { name, engine, unit, every, timezone, startAt, filters };
}

export function listScheduledJobs() {
  const store = read();
  return { jobs: store.jobs, runs: store.runs };
}

export function getScheduledJob(id) {
  if (!isSafeScheduledId(id)) return undefined;
  return read().jobs.find((job) => job.id === id);
}

export async function createScheduledJob(fields) {
  return withScheduledStore(storeFile(), (store) => {
    const now = new Date().toISOString();
    const job = {
      ...fields,
      id: randomUUID(),
      status: "active",
      nextRunAt: fields.startAt,
      createdAt: now,
      updatedAt: now,
    };
    store.jobs.push(job);
    return job;
  });
}

export async function updateScheduledJob(
  id,
  fields,
) {
  return withScheduledStore(storeFile(), (store) => {
    const job = store.jobs.find((item) => item.id === id && item.status !== "deleted");
    if (!job) return null;
    const startChanged = fields.startAt !== job.startAt;
    const cadenceChanged = fields.every !== job.every || fields.unit !== job.unit;
    Object.assign(job, fields, { updatedAt: new Date().toISOString() });
    if (startChanged) {
      job.nextRunAt = fields.startAt;
    } else if (cadenceChanged) {
      job.nextRunAt = nextScheduledRun(job.startAt, fields.every, fields.unit, Date.now(), fields.timezone) || job.nextRunAt;
    }
    return job;
  });
}

export async function patchScheduledJob(id, raw) {
  if (!isSafeScheduledId(id)) return null;
  return withScheduledStore(storeFile(), (store) => {
    const current = store.jobs.find((item) => item.id === id && item.status !== "deleted");
    if (!current) return null;
    let input;
    try { input = assertScheduledJobBody(raw); }
    catch (error) { throw new ScheduledJobValidationError(error instanceof Error ? error.message : "Scheduled job body must be an object."); }
    if (input.status !== undefined && input.status !== "active" && input.status !== "paused") {
      throw new ScheduledJobValidationError("Invalid status.");
    }
    const fields = parseScheduledJobInput(input, current);
    const startChanged = fields.startAt !== current.startAt;
    const cadenceChanged = fields.every !== current.every || fields.unit !== current.unit || fields.timezone !== current.timezone;
    Object.assign(current, fields, input.status ? { status: input.status } : {}, { updatedAt: new Date().toISOString() });
    if (startChanged) current.nextRunAt = fields.startAt;
    else if (cadenceChanged) current.nextRunAt = nextScheduledRun(current.startAt, fields.every, fields.unit, Date.now(), fields.timezone) || current.nextRunAt;
    return current;
  });
}

export async function setScheduledJobStatus(
  id,
  status,
) {
  return withScheduledStore(storeFile(), (store) => {
    const job = store.jobs.find((item) => item.id === id && item.status !== "deleted");
    if (!job) return null;
    job.status = status;
    job.updatedAt = new Date().toISOString();
    return job;
  });
}

export async function deleteScheduledJob(id) {
  return withScheduledStore(storeFile(), (store) => {
    const job = store.jobs.find((item) => item.id === id && item.status !== "deleted");
    if (!job) return null;
    job.status = "deleted";
    job.updatedAt = new Date().toISOString();
    store.queue = store.queue.filter((item) => item.jobId !== id);
    return job;
  });
}

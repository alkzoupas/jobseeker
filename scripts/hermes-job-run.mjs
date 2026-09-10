// Lifecycle primitives for the Hermes-native JobSeeker daily run.
//
// This lock is intentionally separate from data/.lock (short record.mjs writes) and
// data/.browser.lock (serial Chrome work). It prevents two full pipelines from
// overlapping while preserving those narrower locks' ownership rules.

import { promises as fs } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(__dirname, "..");
const TERMINAL_STATES = new Set(["ok", "partial", "failed", "blocked-config"]);

function safeDetail(value) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 500);
}

function safeCoverage(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

async function lockOwnerIsDead(lockFile) {
  try {
    const token = await fs.readFile(lockFile, "utf8");
    const pid = Number.parseInt(token.split(":", 1)[0], 10);
    if (!Number.isSafeInteger(pid) || pid < 1) return false;
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      return error?.code === "ESRCH";
    }
  } catch (error) {
    return error?.code === "ENOENT";
  }
}

async function writeAtomic(file, value) {
  const temp = `${file}.tmp.${process.pid}.${randomUUID()}`;
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temp, file);
}

export function createRunManager({ root = DEFAULT_ROOT } = {}) {
  const data = path.join(root, "data");
  const lockFile = path.join(data, ".hermes-job-run.lock");
  const statusFile = path.join(data, ".hermes-job-run.status.json");

  async function release(token) {
    try {
      const held = await fs.readFile(lockFile, "utf8");
      if (held === token) await fs.rm(lockFile, { force: true });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  return {
    async start({ detail = "", coverage = {} } = {}) {
      await fs.mkdir(data, { recursive: true });
      const token = `${process.pid}:${randomUUID()}`;
      try {
        await fs.writeFile(lockFile, token, { encoding: "utf8", flag: "wx" });
      } catch (error) {
        if (error?.code === "EEXIST" && await lockOwnerIsDead(lockFile)) {
          await fs.rm(lockFile, { force: true });
          return this.start({ detail, coverage });
        }
        if (error?.code === "EEXIST") throw new Error("Hermes JobSeeker run already in progress");
        throw error;
      }

      const started = new Date().toISOString();
      try {
        await writeAtomic(statusFile, {
          state: "started",
          started,
          finished: null,
          detail: safeDetail(detail),
          coverage: safeCoverage(coverage),
        });
      } catch (error) {
        await release(token);
        throw error;
      }
      return { token, started };
    },

    async finish(run, { state, detail = "", coverage = {} } = {}) {
      if (!run?.token || !run?.started) throw new Error("A run returned by start() is required");
      if (!TERMINAL_STATES.has(state)) throw new Error(`Unsupported terminal state: ${state}`);
      try {
        await writeAtomic(statusFile, {
          state,
          started: run.started,
          finished: new Date().toISOString(),
          detail: safeDetail(detail),
          coverage: safeCoverage(coverage),
        });
      } finally {
        await release(run.token);
      }
    },

    paths: { data, lockFile, statusFile },
  };
}

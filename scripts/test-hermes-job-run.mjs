#!/usr/bin/env node
// Regression tests for the Hermes-native JobSeeker run lifecycle.
//
// The scheduler must never overlap two daily runs, and a terminal run must never
// strand its lock or claim a complete digest without structured coverage.

import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { createRunManager } from "./hermes-job-run.mjs";

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
};

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  console.log("\nHermes JobSeeker run lifecycle\n");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "jobseeker-hermes-run-"));
  const data = path.join(root, "data");
  const manager = createRunManager({ root });
  const coverage = { gmail: { state: "complete" }, browser: { state: "skipped", reason: "unavailable" } };

  const first = await manager.start({ detail: "canary started", coverage });
  let overlapRejected = false;
  try {
    await manager.start({ detail: "second run", coverage: {} });
  } catch (error) {
    overlapRejected = /already in progress/.test(String(error?.message));
  }
  check("concurrent run is rejected", overlapRejected);
  check("lock exists while a run is active", await exists(path.join(data, ".hermes-job-run.lock")));

  await manager.finish(first, { state: "ok", detail: "complete", coverage });
  check("lock releases after ok", !(await exists(path.join(data, ".hermes-job-run.lock"))));

  await fs.writeFile(path.join(data, ".hermes-job-run.lock"), "999999:abandoned-cron-owner", "utf8");
  const recovered = await manager.start({ detail: "recovered stale run", coverage });
  check("stale lock from a dead owner is recovered", await exists(path.join(data, ".hermes-job-run.lock")));
  await manager.finish(recovered, { state: "partial", detail: "recovered stale run finished", coverage });
  check("recovered stale lock releases after finish", !(await exists(path.join(data, ".hermes-job-run.lock"))));

  for (const state of ["partial", "failed", "blocked-config"]) {
    const run = await manager.start({ detail: `${state} started`, coverage });
    await manager.finish(run, { state, detail: `${state} finished`, coverage });
    check(`lock releases after ${state}`, !(await exists(path.join(data, ".hermes-job-run.lock"))));
  }

  const status = JSON.parse(await fs.readFile(path.join(data, ".hermes-job-run.status.json"), "utf8"));
  check("status has terminal state", status.state === "blocked-config", status.state);
  check("status has UTC started timestamp", /^\d{4}-\d{2}-\d{2}T/.test(status.started), String(status.started));
  check("status has UTC finished timestamp", /^\d{4}-\d{2}-\d{2}T/.test(status.finished), String(status.finished));
  check("status preserves detail", status.detail === "blocked-config finished", status.detail);
  check("status preserves coverage", status.coverage?.browser?.state === "skipped", JSON.stringify(status.coverage));

  await fs.rm(root, { recursive: true, force: true });
  console.log(failures === 0 ? "\nPASS\n" : `\nFAIL — ${failures} check(s) failed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("test-hermes-job-run error:", error?.message || error);
  process.exit(1);
});

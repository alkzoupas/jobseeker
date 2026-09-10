#!/usr/bin/env node
// Regression tests for the bounded Hermes/Qwen hand-off context.

import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { buildRunContext, writeRunContext } from "./hermes-job-collect.mjs";

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
};

async function main() {
  const gmail = { state: "complete", records: [{ id: "t1", subject: "Interview" }] };
  const staticContext = { state: "partial", results: { keys: { applications: [] } }, coverage: { boards: { state: "failed" } } };
  const browser = { state: "partial", status: { capabilities: { read_page_content: false } }, coverage: { browser: { state: "unavailable", blockers: ["Automation denied"] } } };
  const context = buildRunContext({ started: "2026-09-10T10:00:00.000Z", gmail, staticContext, browser });
  check("context preserves a fixed schema version", context.schema_version === 1, JSON.stringify(context));
  check("context preserves run start", context.started === "2026-09-10T10:00:00.000Z");
  check("context carries bounded Gmail records", context.gmail.records?.[0]?.id === "t1");
  check("context merges explicit coverage", context.coverage.gmail.state === "complete" && context.coverage.boards.state === "failed" && context.coverage.browser.state === "unavailable", JSON.stringify(context.coverage));
  check("context is partial when any source is partial", context.state === "partial", context.state);

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "jobseeker-context-"));
  const written = await writeRunContext({ root, context });
  const file = path.join(root, "data", ".hermes-job-run-context.json");
  const disk = JSON.parse(await fs.readFile(file, "utf8"));
  check("context writes under ignored runtime data", written === file && disk.schema_version === 1, written);
  check("context write is valid JSON", disk.gmail.records?.length === 1);
  const entries = await fs.readdir(path.join(root, "data"));
  check("context write leaves no temp files", !entries.some((entry) => entry.includes(".tmp.")), entries.join(","));
  await fs.rm(root, { recursive: true, force: true });

  console.log(failures === 0 ? "\nPASS\n" : `\nFAIL — ${failures} check(s) failed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => { console.error("test-hermes-job-context error:", error?.message || error); process.exit(1); });

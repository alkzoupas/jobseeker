#!/usr/bin/env node
// Regression tests for deterministic daily-digest finalization.

import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { formatDigest, finalizeDigest } from "./hermes-job-finalize.mjs";

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
};

async function main() {
  const digest = formatDigest({
    date: "10 Sep 2026",
    completed: "09:15",
    started: "09:00",
    state: "partial",
    highlights: ["Interview invitation needs review"],
    postings: [{ company: "Acme", role: "Trust & Safety Engineering Manager", url: "https://example.test/jobs/123" }],
    followups: ["Acme - reply to recruiter"],
    coverage: ["WhatsApp Web and LinkedIn were not read — Automation denied"],
    system: ["Browser permission needs attention"],
  });
  check("digest starts with durable delivery line", digest.startsWith("not-delivered: Telegram delivery delegated to Hermes cron\n"));
  check("digest has required header", digest.includes("Update of 10 Sep 2026 Completed at 09:15"));
  check("digest includes standalone posting URL", digest.includes("https://example.test/jobs/123\n"));
  check("digest includes partial coverage", digest.includes("Coverage\n- WhatsApp Web and LinkedIn were not read — Automation denied"));
  check("digest rejects an unbounded posting list", (() => { try { formatDigest({ postings: Array.from({ length: 6 }, () => ({ company: "A", role: "R" })) }); return false; } catch { return true; } })());

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "jobseeker-finalize-"));
  const result = await finalizeDigest({ root, digest, status: { state: "partial", started: "2026-09-10T16:00:00.000Z", finished: "2026-09-10T16:15:00.000Z", coverage: { browser: { state: "unavailable" } } } });
  const disk = await fs.readFile(path.join(root, "data", ".last-digest.md"), "utf8");
  const status = JSON.parse(await fs.readFile(path.join(root, "data", ".hermes-job-run.status.json"), "utf8"));
  check("finalizer writes digest before delivery", result.digest_file.endsWith(".last-digest.md") && disk === digest);
  check("finalizer writes final status", status.state === "partial" && status.coverage.browser.state === "unavailable", JSON.stringify(status));
  await fs.rm(root, { recursive: true, force: true });

  console.log(failures === 0 ? "\nPASS\n" : `\nFAIL — ${failures} check(s) failed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => { console.error("test-hermes-job-finalize error:", error?.message || error); process.exit(1); });

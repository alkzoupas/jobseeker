#!/usr/bin/env node
// Integration test for the deterministic Hermes/Qwen daily runner wiring.

import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { runDaily } from "./hermes-job-daily.mjs";

let failures = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "  ok  " : "  FAIL"}  ${name}${detail ? " — " + detail : ""}`); if (!ok) failures++; };

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "jobseeker-daily-"));
  const calls = [];
  const result = await runDaily({
    root,
    now: new Date("2026-09-10T16:00:00.000Z"),
    run: async (bin, argv) => {
      calls.push([bin, argv]);
      if (argv[0] === "scripts/browser-probe.mjs") return { stdout: "probe" };
      if (argv[0] === "scripts/browser-do.mjs") return { stdout: "sweep" };
      if (bin === "gog") return { stdout: "[]" };
      if (argv[0] === "server/record.mjs" && argv[1] === "list-boards") return { stdout: JSON.stringify({ by_access: { browser: 1 } }) };
      return { stdout: "{}" };
    },
    readFile: async (file) => file.endsWith(".browser-status.json") ? JSON.stringify({ capabilities: { read_page_content: true, read_mechanism: "apple-events" }, blockers: [] }) : "",
    invokeModel: async (contextPath) => {
      check("model receives persisted context path", contextPath.endsWith(".hermes-job-run-context.json"), contextPath);
      return `The universe is tedious.\n${JSON.stringify({ highlights: ["Nothing urgent"], postings: [], followups: [], coverage: [], system: [] })}\nAnd now, silence.`;
    },
  });
  check("runner never invokes Claude", !calls.some(([bin, argv]) => bin === "claude" || argv.join(" ").includes("claude")), JSON.stringify(calls));
  check("runner invokes only bounded browser sweep", calls.some(([bin, argv]) => bin === "node" && JSON.stringify(argv) === JSON.stringify(["scripts/browser-do.mjs", "board-sweep", "--max", "15"])));
  check("runner finalizes digest", result.state === "ok" && (await fs.readFile(path.join(root, "data", ".last-digest.md"), "utf8")).includes("Nothing urgent"));
  check("runner writes context", await fs.stat(path.join(root, "data", ".hermes-job-run-context.json")).then(() => true, () => false));
  await fs.rm(root, { recursive: true, force: true });
  console.log(failures === 0 ? "\nPASS\n" : `\nFAIL — ${failures} check(s) failed\n`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((error) => { console.error("test-hermes-job-daily error:", error?.message || error); process.exit(1); });

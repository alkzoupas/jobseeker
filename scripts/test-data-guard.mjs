#!/usr/bin/env node
// Guards .claude/helpers/data-guard.mjs, the PreToolUse hook that asks the user before any direct
// edit to data/ or to an AGENT-RULES §18 user input. It never blocks.
//
//   npm run test:data-guard

import { spawnSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import { decide } from "../.claude/helpers/data-guard.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hook = path.join(root, ".claude/helpers/data-guard.mjs");

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
};
const verdict = (p) => decide(p, root)?.decision ?? "none";

check("data/ file asks", verdict("data/tasks.md") === "ask");
check("nested data/ file asks", verdict("data/applications/acme.md") === "ask");
check("absolute data/ path asks", verdict(path.join(root, "data/communications.md")) === "ask");
check("§18 rubric asks", verdict("data/fit-rubric.md") === "ask");
check("§18 decisions asks", verdict("data/decisions.md") === "ask");
check("§18 master CV asks", verdict("templates/cv/trust_resume.tex") === "ask");
check("§18 voice asks", verdict(path.join(root, "templates/cover/voice.md")) === "ask");
check("other template untouched", verdict("templates/cover/cover_master.tex") === "none");
check("server code untouched", verdict("server/record.mjs") === "none");
check("lookalike dir untouched", verdict("data-old/tasks.md") === "none");
check("outside the repo untouched", verdict("/tmp/data/tasks.md") === "none");
check("../ escape untouched", verdict("../data/tasks.md") === "none");
check("no path untouched", verdict(undefined) === "none");

const run = (input) => spawnSync(process.execPath, [hook], {
  input: typeof input === "string" ? input : JSON.stringify(input),
  env: { ...process.env, CLAUDE_PROJECT_DIR: root },
  encoding: "utf8",
});
const asked = run({ tool_name: "Edit", tool_input: { file_path: path.join(root, "data/tasks.md") } });
let out = {};
try { out = JSON.parse(asked.stdout).hookSpecificOutput; } catch {}
check("hook prints an ask decision", asked.status === 0 && out.permissionDecision === "ask" && out.hookEventName === "PreToolUse");
check("reason names the file, not record.mjs", /data\/tasks\.md/.test(out.permissionDecisionReason || "") && !/record\.mjs/.test(out.permissionDecisionReason || ""));
const allowed = run({ tool_name: "Write", tool_input: { file_path: path.join(root, "README.md") } });
check("hook is silent for other files", allowed.status === 0 && allowed.stdout === "");
const garbage = run("not json");
check("hook ignores bad input", garbage.status === 0 && garbage.stdout === "");

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);

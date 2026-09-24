#!/usr/bin/env node
// Triage verdicts (record.mjs triage / override / list-triage).
//
// The rubric's invariants are enforced in code, not left to the agent prompt, so they get tests:
// domain and structural stay separate, a structural Fail names its rule and is always SKIP, the
// user's override survives a re-run of the model, and every override lands in data/decisions.md.
//
// Runs against a throwaway copy of server/ + a minimal data/ — never touches real state.
//
//   npm run test:triage

import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import { execFile } from "child_process";
import { promisify } from "util";
import { validateTriage } from "../server/record.mjs";

const run = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
};
const throws = (fn) => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
};

console.log("validateTriage");
const good = { bucket: "apply", domain: "strong", structural: "pass", score: 82, reason: "T&S detection EM, remote.", flags: ["commute", "hands-on ambiguity"] };
const v = validateTriage(good);
check("normalises case", v.triage_bucket === "APPLY" && v.triage_domain === "Strong" && v.triage_structural === "Pass");
check("flags array becomes one cell", v.triage_flags === "commute; hands-on ambiguity");
check("a Pass carries no rule", v.triage_rule === "");
check("structural Fail without a rule is rejected", throws(() => validateTriage({ ...good, bucket: "SKIP", structural: "Fail" })));
check("structural Fail outside SKIP is rejected, whatever the score", throws(() => validateTriage({ ...good, structural: "Fail", rule: "4", score: 99 })));
check("structural Fail + rule + SKIP is accepted", validateTriage({ ...good, bucket: "SKIP", structural: "Fail", rule: "5 infra relabeled as AI" }).triage_rule === "5 infra relabeled as AI");
check("unknown domain is rejected", throws(() => validateTriage({ ...good, domain: "Medium" })));
check("score outside 0-100 is rejected", throws(() => validateTriage({ ...good, score: 140 })));
check("non-integer score is rejected", throws(() => validateTriage({ ...good, score: "high" })));
check("missing reason is rejected", throws(() => validateTriage({ ...good, reason: " " })));
check("LOOK_CLOSER spelling is accepted", validateTriage({ ...good, bucket: "look_closer" }).triage_bucket === "LOOK CLOSER");
const f = validateTriage({ bucket: "FILTERED", rule: "H1 title: VP", reason: "VP title." });
check("FILTERED needs only rule + reason, and blanks the rest", f.triage_rule === "H1 title: VP" && f.triage_domain === "" && f.triage_score === "");
check("FILTERED without a rule is rejected", throws(() => validateTriage({ bucket: "FILTERED", reason: "x" })));

async function cli() {
  console.log("\nrecord.mjs triage / override / list-triage");
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "jobseeker-triage-"));
  await fs.mkdir(path.join(tmp, "server"), { recursive: true });
  await fs.mkdir(path.join(tmp, "data", "proposals"), { recursive: true });
  for (const file of await fs.readdir(path.join(REPO, "server"))) {
    if (file.endsWith(".mjs")) await fs.copyFile(path.join(REPO, "server", file), path.join(tmp, "server", file));
  }
  const rec = async (...args) => JSON.parse((await run("node", [path.join(tmp, "server", "record.mjs"), ...args], { cwd: tmp })).stdout);
  const recFails = async (...args) => {
    try {
      await rec(...args);
      return false;
    } catch {
      return true;
    }
  };

  const a = (await rec("upsert-proposal", JSON.stringify({ company: "Acme", role: "EM, Trust & Safety", status: "proposed", priority: 0.5, rationale: "body kept" }))).id;
  const b = (await rec("upsert-proposal", JSON.stringify({ company: "Beta", role: "EM, ML Platform", status: "proposed", priority: 0.9 }))).id;
  const c = (await rec("upsert-proposal", JSON.stringify({ company: "Gamma", role: "EM, Applied ML", status: "proposed", priority: 0.2 }))).id;

  let lt = await rec("list-triage", "--untriaged");
  check("all three start untriaged", lt.count === 3);

  await rec("triage", a, JSON.stringify({ bucket: "APPLY", domain: "Strong", structural: "Pass", score: 80, reason: "Core T&S." }));
  await rec("triage", b, JSON.stringify({ bucket: "SKIP", domain: "Adjacent", structural: "Fail", rule: "5", score: 70, reason: "Platform work." }));
  await rec("triage", c, JSON.stringify({ bucket: "APPLY", domain: "Adjacent", structural: "Pass", score: 90, reason: "Applied ML." }));
  check("an invalid verdict is refused by the CLI", await recFails("triage", c, JSON.stringify({ bucket: "APPLY", domain: "Strong", structural: "Fail", rule: "4", score: 90, reason: "x" })));
  check("an unknown id is refused", await recFails("triage", "prop_nope", JSON.stringify(good)));

  lt = await rec("list-triage");
  check("ordered by bucket, then score within a bucket", lt.proposals.map((p) => p.id).join(",") === [c, a, b].join(","), lt.proposals.map((p) => `${p.company}:${p.bucket}:${p.score}`).join(" "));
  check("nothing left untriaged", (await rec("list-triage", "--untriaged")).count === 0);
  const body = await fs.readFile(path.join(tmp, "data", "proposals", `${a}.md`), "utf8");
  check("the proposal body (rationale) is kept", body.includes("body kept"));

  const o = await rec("override", b, "LOOK", "CLOSER", "Platform", "title", "but", "the", "JD", "is", "detection");
  check("override moves the bucket and reports from/to", o.from === "SKIP" && o.to === "LOOK CLOSER");
  check("override without a reason is refused", await recFails("override", a, "SKIP"));
  const kept = await rec("triage", b, JSON.stringify({ bucket: "SKIP", domain: "Adjacent", structural: "Fail", rule: "5", score: 70, reason: "Platform work." }));
  check("a re-run of the model does not undo the user's override", kept.action === "kept-override");
  const log = await fs.readFile(path.join(tmp, "data", "decisions.md"), "utf8");
  check("the override is logged to data/decisions.md with its reason", /\| SKIP \| LOOK CLOSER \| Platform title but the JD is detection \|/.test(log));

  await rec("triage", c, JSON.stringify({ bucket: "FILTERED", rule: "H1 title: VP", reason: "VP title." }));
  const cRow = (await rec("list-triage")).proposals.find((p) => p.id === c);
  check("re-judging as FILTERED clears the old domain and score", cRow.domain === "" && cRow.score === null && cRow.rule === "H1 title: VP");
  await fs.rm(tmp, { recursive: true, force: true });
}

await cli();
console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);

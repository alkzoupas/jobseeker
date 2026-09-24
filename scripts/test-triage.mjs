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
import { titleFilter, locationHardFilter, hardFilter, renderReport } from "./triage.mjs";
import { apiPlan, fromApi, htmlToText, jsonLdJobPosting, linkedinDescription, closedSignal, fetchJd, THIN_CHARS } from "./fetch-jd.mjs";

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

async function jd() {
  console.log("\nfetch-jd (no network)");
  const plan = (u, slug) => apiPlan(u, slug) || {};
  check("greenhouse job-boards URL → board API", plan("https://job-boards.greenhouse.io/vercel/jobs/6115908004").url === "https://boards-api.greenhouse.io/v1/boards/vercel/jobs/6115908004");
  check("company careers ?gh_jid= uses the registry's Greenhouse slug", plan("https://careers.roblox.com/jobs/8077261?gh_jid=8077261", "roblox").url === "https://boards-api.greenhouse.io/v1/boards/roblox/jobs/8077261");
  check("?gh_jid= without a known slug has no API plan", apiPlan("https://stripe.com/jobs/search?gh_jid=8172489") === null);
  check("lever → postings API", plan("https://jobs.lever.co/loopreturns/8756c2b5-f502").url === "https://api.lever.co/v0/postings/loopreturns/8756c2b5-f502");
  check("ashby → board API + job id", plan("https://jobs.ashbyhq.com/suno/9ed2cea6").jobId === "9ed2cea6");
  check("smartrecruiters → postings API by numeric id", plan("https://jobs.smartrecruiters.com/ServiceNow/744000146526999-senior-manager").url === "https://api.smartrecruiters.com/v1/companies/ServiceNow/postings/744000146526999");
  check("gem → board API + job id", plan("https://jobs.gem.com/fetch/am9icG9zdDp2").jobId === "am9icG9zdDp2");
  check("workday → cxs API, locale segment dropped", plan("https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/Director_JR1").url === "https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/Director_JR1");
  check("LinkedIn has no API plan", apiPlan("https://www.linkedin.com/jobs/view/4469498180/") === null);

  check("htmlToText keeps list structure", htmlToText("<p>Intro</p><ul><li>One</li><li>Two &amp; three</li></ul>") === "Intro\n\n- One\n- Two & three");
  check("htmlToText decodes Greenhouse's entity-escaped HTML", htmlToText("&lt;p&gt;Hello &amp;amp; bye&lt;/p&gt;") === "Hello & bye");
  check("htmlToText drops scripts", !htmlToText("<script>var x=1</script><p>JD</p>").includes("var"));
  const ld = jsonLdJobPosting(`<script type="application/ld+json">{"@type":"JobPosting","title":"EM","description":"&lt;p&gt;Build detection&lt;/p&gt;"}</script>`);
  check("JSON-LD JobPosting is extracted", ld && ld.title === "EM" && ld.text === "Build detection");
  const li = linkedinDescription(`<title>EM at Acme | LinkedIn</title><div class="show-more-less-html__markup description__text">Own <b>abuse</b> detection</div><button class="show-more-less-html__button">`);
  check("LinkedIn description block is extracted, title cleaned", li && li.text === "Own abuse detection" && li.title === "EM at Acme");
  check("closed notice deep in a whole page is found", /Job not found/.test(closedSignal(`<p>nav</p>${"<p>footer</p>".repeat(400)}<p>Job not found. This job may have been taken down.</p>`, { whole: true })));
  check("a JD saying 'no longer' past the banner is not closed", closedSignal(`<p>${"x ".repeat(2000)} this position is closed to agencies</p>`) === "");
  check("fromApi(greenhouse) reads content", fromApi("greenhouse", { title: "EM", content: "&lt;p&gt;Hi&lt;/p&gt;" }).text === "Hi");
  check("fromApi(ashby) finds the job by id", fromApi("ashby", { jobs: [{ id: "a", title: "A", descriptionPlain: "AAA" }, { id: "b", title: "B", descriptionPlain: "BBB" }] }, "b").text === "BBB");

  const long = "Detect abuse. ".repeat(100);
  const fake = (map) => async (url) => (url in map ? { ok: true, status: 200, body: map[url] } : { ok: false, status: 404, body: "" });
  let r = await fetchJd("https://jobs.lever.co/acme/1", { fetcher: fake({ "https://api.lever.co/v0/postings/acme/1": JSON.stringify({ text: "EM", descriptionPlain: long }) }) });
  check("API answer wins when it is a full JD", r.via === "lever-api" && !r.thin);
  r = await fetchJd("https://jobs.lever.co/acme/2", { fetcher: fake({ "https://jobs.lever.co/acme/2": `<script type="application/ld+json">{"@type":"JobPosting","description":"${long}"}</script>` }) });
  check("API 404 falls back to the page's JSON-LD", r.via === "json-ld" && !r.thin);
  r = await fetchJd("https://www.linkedin.com/jobs/view/1/", { fetcher: fake({ "https://www.linkedin.com/jobs/view/1/": `<title>Jobs</title><p>${long}</p>` }) });
  check("a LinkedIn page without the description block is thin, never page text", r.thin && r.text === "");
  r = await fetchJd("https://careers.example.com/j/1", { fetcher: fake({ "https://careers.example.com/j/1": `<p>${long}</p><p>Job not found.</p>` }) });
  check("a page that says the job is gone is closed, not a JD", r.closed === true && r.text === "");
  let asked = false;
  const browserFetch = async () => ((asked = true), { title: "t", text: long });
  r = await fetchJd("https://spa.example.com/j/1", { fetcher: fake({ "https://spa.example.com/j/1": "<div id=app></div>" }), browserFetch });
  check("Chrome is NOT used unless the caller opts in", r.thin && !asked);
  r = await fetchJd("https://spa.example.com/j/1", { fetcher: fake({ "https://spa.example.com/j/1": "<div id=app></div>" }), browser: true, browserFetch });
  check("with --browser, a JS-rendered page is read through Chrome", r.via === "browser" && asked && r.text.length >= THIN_CHARS);
}

function hard() {
  console.log("\ntriage hard filters + report");
  const rule = (t) => titleFilter(t)?.rule || null;
  check("Senior Director is H1", rule("Senior Director Engineering, YouTube Trust and Safety") === "H1 level");
  check("VP / SVP / CTO / Chief … Officer are H1", ["VP of Engineering", "SVP, Trust", "CTO", "Chief Technology Officer"].every((t) => rule(t) === "H1 level"));
  check("plain Director is NOT filtered (the judge decides)", rule("Director, Trust & Safety") === null && rule("Director of Engineering") === null);
  check("Head of Engineering is NOT filtered (org size is a judgement)", rule("Head of Engineering") === null);
  check("Product Manager is H2 even with ML in the title", rule("Senior Product Manager, Machine Learning") === "H2 function");
  check("Engineering Manager, Product is NOT H2", rule("Engineering Manager, Product Integrity") === null);
  check("sales / solutions engineering is H2", rule("Director of Solutions Engineering") === "H2 function" && rule("Sales Engineering Manager") === "H2 function");
  check("an engineering role for marketing is NOT H2", rule("Engineering Manager, Marketing Technology") === null);
  check("Recruiter / Legal Counsel are H2", rule("Technical Recruiter") === "H2 function" && rule("Legal Counsel, Trust") === "H2 function");
  check("the target title passes", rule("Engineering Manager, Trust & Safety") === null);
  const locs = ["San Francisco Bay Area", "Remote US"];
  check("Pittsburgh on-site is H3", locationHardFilter("Pittsburgh, PA", locs)?.rule === "H3 location");
  check("one in-scope place among several passes", locationHardFilter("San Francisco, CA; New York, NY", locs) === null);
  check("Mountain View passes (commute is a flag, not a filter)", locationHardFilter("Mountain View, CA (On-site)", locs) === null);
  check("US remote passes", locationHardFilter("United States (Remote)", locs) === null);
  check("an empty location is never filtered", locationHardFilter("", locs) === null);
  check("a closed posting is H0 before anything else", hardFilter({ role: "Engineering Manager" }, { jd: { closed: "yes" } })?.rule === "H0 closed");

  const rows = [
    { id: "p1", company: "A", role: "EM", bucket: "SKIP", domain: "Strong", structural: "Fail", rule: "8 5-day office", score: 90, reason: "Office 5 days.", job_url: "https://a" },
    { id: "p2", company: "B", role: "EM", bucket: "APPLY", domain: "Strong", structural: "Pass", score: 70, reason: "Core T&S.", flags: "commute", job_url: "https://b", questions: "How hands-on?" },
    { id: "p3", company: "C|D", role: "EM", bucket: "APPLY", domain: "Adjacent", structural: "Pass", score: 85, reason: "Eval.", job_url: "" },
    { id: "p4", company: "E", role: "VP Eng", bucket: "FILTERED", rule: "H1 level", reason: "VP.", location: "SF" },
  ];
  const { markdown, map } = renderReport({ date: "2026-09-24", rows, scan: { generated_at: "2026-09-24T01:00:00Z", counts: { dropped: { location: 5 } }, dropped_samples: { location: [{ company: "X", title: "EM", why: "outside" }], title_near_miss: [] } } });
  check("rows numbered APPLY first, by score, SKIP last", map[1] === "p3" && map[2] === "p2" && map[3] === "p1", JSON.stringify(map));
  check("FILTERED rows are not numbered in the table", !Object.values(map).includes("p4"));
  check("a structural Fail shows its rule", markdown.includes("| Fail (8 5-day office) |"));
  check("pipes in cells are escaped", markdown.includes("C\\|D"));
  check("Filtered out lists the rule", /E — VP Eng \(SF\) · \*\*H1 level\*\*/.test(markdown));
  check("board-scan drops are listed for false-negative review", markdown.includes("Location drops (1 of 5)"));
  check("early questions are carried for non-SKIP rows", markdown.includes("**#2 B:** How hands-on?"));
}

await cli();
await jd();
hard();
console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);

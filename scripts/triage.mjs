#!/usr/bin/env node
// The mechanical half of triage: the rubric's binary hard filters, and the per-run report.
// The judgement half (domain / structural / flags / bucket, from the full JD) is triage-agent.
//
//   node scripts/triage.mjs hard-filter [--dry-run]   # untriaged proposals → FILTERED + rule, via record.mjs
//   node scripts/triage.mjs report [--date YYYY-MM-DD] [--notes <file>]
//        → output/triage_<date>.md (+ .json mapping row # → proposal id, for overrides like "#4 → SKIP")
//
// Hard filters are the ones data/fit-rubric.md calls "truly binary". Everything else is left to the
// judge, on purpose: a wrong filter hides a role, so these stay conservative, and every filtered
// role is listed under "Filtered out" in the report with the rule that caught it.
//   H0  the posting says it is gone (from fetch-jd's cache)
//   H1  title level: VP / SVP / CTO / Chief … Officer / Senior Director
//   H2  non-engineering function: Product Manager, Recruiter, Sales / Solutions engineering,
//       Sales, Marketing, Legal
//   H3  on-site or hybrid, located outside data/criteria.md `locations`
// Commute inside the Bay Area is NOT a filter. The rubric makes it a weighted flag for the judge.

import { promises as fs, realpathSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execFile } from "child_process";
import { readRecordDir, parseFrontmatter } from "../server/md.mjs";
import { locationFilter } from "./board-scan.mjs";
import { readCache } from "./fetch-jd.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA = path.join(ROOT, "data");
const OUT = path.join(ROOT, "output");

// ---------------------------------------------------------------------------------------------
// Hard filters (pure, tested in scripts/test-triage.mjs)
// ---------------------------------------------------------------------------------------------

const LEVEL_RE = /\b(s?vp|vice president|cto|chief [a-z ]{0,30}officer|(senior|sr\.?) director|executive director)\b/i;
const ENG_RE = /\b(engineering|engineer|software|machine learning|ml|ai|data science|technical)\b/i;

export function titleFilter(title) {
  const t = String(title || "");
  const lvl = LEVEL_RE.exec(t);
  if (lvl) return { rule: "H1 level", why: `title level "${lvl[0]}" is above the target (rubric: hard filters)` };
  const fn =
    /\bproduct manage(r|ment)\b/i.exec(t) ||
    /\brecruit(er|ing|ment)\b/i.exec(t) ||
    /\b(sales|solutions?|pre-?sales) engineer(ing)?\b/i.exec(t) ||
    // Sales / marketing / legal only when the title is not an engineering role FOR that area
    // ("Engineering Manager, Marketing Technology" is an engineering job).
    (!ENG_RE.test(t) && /\b(sales|marketing|legal|counsel)\b/i.exec(t));
  if (fn) return { rule: "H2 function", why: `non-engineering function "${fn[0]}"` };
  return null;
}

// A proposal's location is free text, often several places ("San Francisco, CA; New York, NY").
// Split it so one in-scope place is enough, then use board-scan's matcher (same rules as the scan).
export function locationHardFilter(location, locations) {
  const raw = String(location || "").trim();
  if (!raw || !locations?.length) return null;
  const parts = raw.split(/\s*(?:;|\/|\||\bor\b)\s*/i).map((s) => s.trim()).filter(Boolean);
  const v = locationFilter(locations)({ locations: parts.length ? parts : [raw] });
  if (v.verdict !== "no") return null;
  return { rule: "H3 location", why: `${v.why.replace(/^not in /, "outside ")}` };
}

export function hardFilter(p, { locations = [], jd = null } = {}) {
  if (jd && jd.closed === "yes") return { rule: "H0 closed", why: `posting is gone (fetch-jd, ${jd.fetched?.slice(0, 10) || "cached"})` };
  return titleFilter(p.role) || locationHardFilter(p.location, locations);
}

// ---------------------------------------------------------------------------------------------
// Report (pure)
// ---------------------------------------------------------------------------------------------

const cell = (v) => String(v ?? "").replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ").trim();
const BUCKETS = ["APPLY", "LOOK CLOSER", "SKIP"];

export function renderReport({ date, rows, scan = null, notes = "" }) {
  const judged = rows.filter((r) => BUCKETS.includes(r.bucket));
  const filtered = rows.filter((r) => r.bucket === "FILTERED");
  const order = (b) => BUCKETS.indexOf(b);
  judged.sort((a, b) => order(a.bucket) - order(b.bucket) || (b.score ?? -1) - (a.score ?? -1));
  const map = {};
  const counts = Object.fromEntries(BUCKETS.map((b) => [b, judged.filter((r) => r.bucket === b).length]));

  const L = [];
  L.push(`# Triage — ${date}`, "");
  L.push(
    `${judged.length} judged: **${counts.APPLY} APPLY** · ${counts["LOOK CLOSER"]} LOOK CLOSER · ${counts.SKIP} SKIP` +
      ` · ${filtered.length} filtered out by code. Score orders roles within a bucket only.`,
    ""
  );
  if (notes.trim()) L.push(notes.trim(), "");
  L.push("| # | Company | Role | Location | Domain | Structural | Flags | Score | Bucket | Reason | Link |");
  L.push("|---|---------|------|----------|--------|------------|-------|-------|--------|--------|------|");
  judged.forEach((r, i) => {
    const n = i + 1;
    map[n] = r.id;
    const structural = r.structural === "Fail" ? `Fail (${r.rule})` : r.structural;
    const bucket = r.override ? `${r.bucket} (your call)` : r.bucket;
    L.push(
      `| ${n} | ${cell(r.company)} | ${cell(r.role)} | ${cell(r.location)} | ${cell(r.domain)} | ${cell(structural)} | ${cell(r.flags)} | ${r.score ?? ""} | ${bucket} | ${cell(r.reason)} | ${r.job_url ? `[posting](${r.job_url})` : ""} |`
    );
  });
  L.push("");
  const qs = judged.filter((r) => r.bucket !== "SKIP" && r.questions);
  if (qs.length) {
    L.push("## Ask early", "");
    for (const r of qs) L.push(`- **#${Object.keys(map).find((k) => map[k] === r.id)} ${r.company}:** ${r.questions}`);
    L.push("");
  }
  L.push("## Filtered out", "");
  if (!filtered.length) L.push("- No proposals were filtered by code this run.");
  for (const r of filtered) L.push(`- ${r.company} — ${r.role} (${r.location || "location not stated"}) · **${r.rule}** · ${r.reason}`);
  L.push("");
  if (scan) {
    const loc = scan.dropped_samples?.location || [];
    const near = scan.dropped_samples?.title_near_miss || [];
    const total = scan.counts?.dropped || {};
    L.push(
      `Board scan (${String(scan.generated_at || "").slice(0, 10)}) also dropped ${total.location ?? loc.length} postings on location and ` +
        `${near.length} near-miss titles before they became proposals. Samples below, so you can spot a wrong drop.`,
      ""
    );
    if (near.length) {
      L.push(`<details><summary>Near-miss titles (${near.length})</summary>`, "");
      for (const x of near) L.push(`- ${x.company} — ${x.title} · ${x.why}`);
      L.push("", "</details>", "");
    }
    if (loc.length) {
      L.push(`<details><summary>Location drops (${loc.length} of ${total.location ?? loc.length})</summary>`, "");
      for (const x of loc) L.push(`- ${x.company} — ${x.title} · ${x.why}`);
      L.push("", "</details>", "");
    }
  }
  L.push("Overrides: tell me e.g. \"#4 should be SKIP, Foster City 4 days/week is too far\". Each one is saved to `data/decisions.md` and read before the next triage run.", "");
  return { markdown: L.join("\n"), map };
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

function record(args) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [path.join(ROOT, "server", "record.mjs"), ...args], { cwd: ROOT, timeout: 60_000 }, (err, stdout, stderr) =>
      err ? reject(new Error(String(stderr || err.message))) : resolve(JSON.parse(String(stdout).trim()))
    );
  });
}

async function criteriaLocations() {
  try {
    const c = parseFrontmatter(await fs.readFile(path.join(DATA, "criteria.md"), "utf8")).data || {};
    return String(c.locations || "").split(",").map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

async function hardFilterCmd(dry) {
  const locations = await criteriaLocations();
  const props = (await readRecordDir(path.join(DATA, "proposals"))).map((r) => r.data).filter((d) => d && d.id);
  const todo = props.filter((d) => String(d.status || "proposed") === "proposed" && !d.triage_bucket);
  const out = { checked: todo.length, filtered: [], passed: 0, dry_run: dry };
  for (const p of todo) {
    const hit = hardFilter(p, { locations, jd: await readCache(p.id) });
    if (!hit) {
      out.passed++;
      continue;
    }
    out.filtered.push({ id: p.id, company: p.company, role: p.role, rule: hit.rule, why: hit.why });
    if (!dry) await record(["triage", p.id, JSON.stringify({ bucket: "FILTERED", rule: hit.rule, reason: hit.why })]);
  }
  return out;
}

async function reportCmd(date, notesFile) {
  const { proposals } = await record(["list-triage", "--date", date]);
  let scan = null;
  try {
    scan = JSON.parse(await fs.readFile(path.join(DATA, ".board-scan.json"), "utf8"));
    // A scan from last week says nothing about this run's false negatives.
    if ((Date.parse(date) - Date.parse(String(scan.generated_at).slice(0, 10))) / 86_400_000 > 2) scan = null;
  } catch {
    /* no scan yet */
  }
  const notes = notesFile ? await fs.readFile(notesFile, "utf8") : "";
  const { markdown, map } = renderReport({ date, rows: proposals, scan, notes });
  await fs.mkdir(OUT, { recursive: true });
  const md = path.join(OUT, `triage_${date}.md`);
  await fs.writeFile(md, markdown + "\n");
  await fs.writeFile(path.join(OUT, `triage_${date}.json`), JSON.stringify({ date, rows: map }, null, 2) + "\n");
  return { file: path.relative(ROOT, md), rows: Object.keys(map).length, filtered: proposals.filter((p) => p.bucket === "FILTERED").length };
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flag = (n, d = null) => {
    const i = rest.indexOf(n);
    return i >= 0 && rest[i + 1] ? rest[i + 1] : d;
  };
  // UTC, like record.mjs's triage_date stamp, so the default date always matches what was written.
  const today = new Date().toISOString().slice(0, 10);
  let result;
  if (cmd === "hard-filter") result = await hardFilterCmd(rest.includes("--dry-run"));
  else if (cmd === "report") result = await reportCmd(flag("--date", today), flag("--notes"));
  else throw new Error("usage: triage.mjs hard-filter [--dry-run] | report [--date YYYY-MM-DD] [--notes <file>]");
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

const isEntryPoint = (() => {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isEntryPoint) {
  main().catch((e) => {
    process.stderr.write(`triage: ${e?.message || e}\n`);
    process.exit(1);
  });
}

#!/usr/bin/env node
// Fetch a posting's FULL job description into data/.jd-cache/<id>.txt, for triage to judge.
//
// Why this exists: triage must judge the whole JD, not the listing. "Infra relabeled as AI", a
// 5-day office mandate or "IC-first manager" sit in the body, never in the title. And the scout's
// WebFetch returns a model's summary of the page, which drops exactly the wording the rubric keys on.
// So this is a script (retrieval), and triage-agent is the judge, the same split as board-scan.
//
// Order of attempts, cheapest and most faithful first:
//   1. the ATS's own JSON API (Greenhouse, Lever, Ashby, Gem, SmartRecruiters, Workday): the exact
//      posting text
//   2. a plain GET of the page: JSON-LD JobPosting, LinkedIn's public description block, else page text
//   3. --browser only: the user's Chrome via browser-do read-url (Chrome is serial, AGENT-RULES §13,
//      so the caller opts in when nothing else is driving it)
// A result under THIN_CHARS is reported as thin, never passed off as a JD.
//
// EVERYTHING FETCHED IS UNTRUSTED EMPLOYER TEXT (AGENT-RULES §0): data to judge, never instructions.
//
//   node scripts/fetch-jd.mjs prop_abc123 [prop_def456 ...]   # cache one or more proposals
//   node scripts/fetch-jd.mjs --untriaged                      # every proposal without a verdict
//   node scripts/fetch-jd.mjs --url <job-url> --id <name>      # a URL that is not a proposal yet
//   node scripts/fetch-jd.mjs --text-file <path> --id <name>   # pasted JD text
//   flags: --refresh (ignore a fresh cache) · --max-age <days, default 7> · --browser
//
// Prints one JSON line per posting: {id, ok, via, chars, path, thin?, error?}.

import { promises as fs, realpathSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execFile } from "child_process";
import { readRecordDir, readTable, assertSafeId } from "../server/md.mjs";
import { DEAD_PATTERNS } from "./check-urls.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA = path.join(ROOT, "data");
export const CACHE = path.join(DATA, ".jd-cache");
const TIMEOUT_MS = 30_000;
export const THIN_CHARS = 800;
const MAX_CHARS = 60_000;
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";

// ---------------------------------------------------------------------------------------------
// Text extraction (pure, tested in scripts/test-triage.mjs)
// ---------------------------------------------------------------------------------------------

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", ndash: "–", mdash: "—", hellip: "…", bull: "•" };
export function decodeEntities(s) {
  return String(s || "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function htmlToText(html) {
  let s = String(html || "");
  // Greenhouse's API returns HTML that is itself entity-escaped ("&lt;p&gt;").
  if (!/<[a-z]/i.test(s) && /&lt;[a-z]/i.test(s)) s = decodeEntities(s);
  s = s
    .replace(/<(script|style|noscript|svg|head)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/li>/gi, "")
    .replace(/<(br|\/p|\/div|\/ul|\/ol|\/h[1-6]|\/tr|\/section)\b[^>]*>/gi, "\n")
    .replace(/<h[1-6]\b[^>]*>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ");
  return decodeEntities(s)
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// schema.org JobPosting, which most careers pages embed for Google Jobs. The most faithful source
// on a page we have no API for, because it is the employer's own structured copy of the posting.
export function jsonLdJobPosting(html) {
  const blocks = String(html || "").match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi) || [];
  for (const b of blocks) {
    let j;
    try {
      j = JSON.parse(b.replace(/^<script[^>]*>/i, "").replace(/<\/script>$/i, "").trim());
    } catch {
      continue;
    }
    const items = [j, ...(Array.isArray(j) ? j : []), ...(Array.isArray(j?.["@graph"]) ? j["@graph"] : [])];
    const jp = items.find((x) => x && /JobPosting/i.test(String(x["@type"] || "")) && x.description);
    if (jp) return { title: jp.title || "", text: htmlToText(jp.description) };
  }
  return null;
}

// LinkedIn's public job page carries the description in a known block; there is no JSON-LD.
export function linkedinDescription(html) {
  const h = String(html || "");
  const i = h.search(/class="[^"]*description__text[^"]*"/);
  if (i < 0) return null;
  let seg = h.slice(i, i + 80_000);
  // Cut at the START of the "show more" button tag, not at its class name mid-tag.
  const end = seg.search(/<[^<>]*show-more-less-html__button|<\/section>/);
  if (end > 0) seg = seg.slice(0, end);
  const text = htmlToText(seg.replace(/^[^>]*>/, ""));
  const title = (/<title>([^<]*)<\/title>/i.exec(h)?.[1] || "").replace(/\s*\|\s*LinkedIn.*$/i, "");
  return text ? { title: decodeEntities(title), text } : null;
}

// A posting page that says the job is gone, using check-urls' soft-404 fingerprints so there is ONE
// list to extend. Checked on the raw page only (never on API text, which IS the posting): a closed
// Google posting still serves ~6k chars of navigation that would otherwise pass for a job
// description, with "Job not found." after the footer, so page-text is scanned whole. Structured
// sources (JSON-LD, LinkedIn's block) are the posting itself, so only their title and top banner are.
// The bare /404/ fingerprint is dropped here: over a whole JD page it is noise.
const CLOSED_PATTERNS = DEAD_PATTERNS.filter((re) => re.source !== "404");
export function closedSignal(html, { whole = false } = {}) {
  const h = String(html || "");
  const title = /<title>([^<]*)/i.exec(h)?.[1] || "";
  const text = htmlToText(h);
  for (const hay of [title, whole ? text : text.slice(0, 3000)]) {
    for (const re of CLOSED_PATTERNS) {
      const m = re.exec(hay);
      if (m) return hay.slice(Math.max(0, m.index - 20), m.index + m[0].length + 40).replace(/\s+/g, " ").trim();
    }
  }
  return "";
}

// Which ATS API, if any, serves this posting URL. `ghSlug` is the company's Greenhouse board slug
// from data/boards.md, for a careers site that only carries ?gh_jid= (careers.roblox.com/jobs/1?gh_jid=1).
export function apiPlan(url, ghSlug = "") {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split("/").filter(Boolean);
  if (/(^|\.)greenhouse\.io$/.test(host)) {
    const j = parts.indexOf("jobs");
    const slug = parts[0] === "embed" ? u.searchParams.get("for") : parts[0];
    const id = j >= 0 ? parts[j + 1] : u.searchParams.get("token");
    if (slug && id) return { kind: "greenhouse", url: `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs/${id}` };
  }
  const ghJid = u.searchParams.get("gh_jid");
  if (ghJid && ghSlug) return { kind: "greenhouse", url: `https://boards-api.greenhouse.io/v1/boards/${ghSlug}/jobs/${ghJid}` };
  if (/(^|\.)lever\.co$/.test(host) && parts.length >= 2) {
    const api = /\.eu\./.test(host) ? "api.eu.lever.co" : "api.lever.co";
    return { kind: "lever", url: `https://${api}/v0/postings/${parts[0]}/${parts[1]}` };
  }
  if (host === "jobs.ashbyhq.com" && parts.length >= 2) {
    return { kind: "ashby", url: `https://api.ashbyhq.com/posting-api/job-board/${parts[0]}?includeCompensation=true`, jobId: parts[1] };
  }
  if (host === "jobs.smartrecruiters.com" && parts.length >= 2) {
    const id = /^\d+/.exec(parts[1])?.[0];
    if (id) return { kind: "smartrecruiters", url: `https://api.smartrecruiters.com/v1/companies/${parts[0]}/postings/${id}` };
  }
  if (host === "jobs.gem.com" && parts.length >= 2) {
    return { kind: "gem", url: `https://api.gem.com/job_board/v0/${parts[0]}/job_posts`, jobId: parts[1] };
  }
  if (/\.myworkdayjobs\.com$/.test(host)) {
    const tenant = host.split(".")[0];
    const p = /^[a-z]{2}-[A-Z]{2}$/.test(parts[0]) ? parts.slice(1) : parts;
    const j = p.indexOf("job");
    if (j >= 1) return { kind: "workday", url: `https://${host}/wday/cxs/${tenant}/${p[0]}/${p.slice(j).join("/")}` };
  }
  return null;
}

// The posting text out of each API's JSON.
export function fromApi(kind, j, jobId = "") {
  if (kind === "greenhouse" && j?.content) return { title: j.title || "", text: htmlToText(j.content) };
  if (kind === "lever" && (j?.descriptionPlain || j?.description)) {
    const lists = (j.lists || []).map((l) => `\n${l.text || ""}\n${htmlToText(l.content)}`).join("\n");
    return { title: j.text || "", text: [j.descriptionPlain || htmlToText(j.description), lists, j.additionalPlain || ""].join("\n").trim() };
  }
  if (kind === "ashby") {
    const job = (j?.jobs || []).find((x) => x.id === jobId || String(x.jobUrl || "").includes(jobId));
    if (job) return { title: job.title || "", text: job.descriptionPlain || htmlToText(job.descriptionHtml) };
  }
  if (kind === "smartrecruiters" && j?.jobAd?.sections) {
    const sec = j.jobAd.sections;
    const text = ["jobDescription", "qualifications", "additionalInformation", "companyDescription"]
      .map((k) => (sec[k]?.text ? `${sec[k].title || ""}\n${htmlToText(sec[k].text)}` : ""))
      .filter(Boolean).join("\n\n");
    const loc = j.location ? `\nLocation: ${[j.location.city, j.location.region, j.location.country].filter(Boolean).join(", ")}${j.location.remote ? " (remote)" : ""}` : "";
    return { title: j.name || "", text: text + loc };
  }
  if (kind === "gem" && Array.isArray(j)) {
    const job = j.find((x) => String(x.absolute_url || "").endsWith(`/${jobId}`) || x.id === jobId);
    if (job) return { title: job.title || "", text: job.content_plain || htmlToText(job.content) };
  }
  if (kind === "workday" && j?.jobPostingInfo?.jobDescription) {
    const info = j.jobPostingInfo;
    return { title: info.title || "", text: [htmlToText(info.jobDescription), info.location ? `Location: ${info.location}` : ""].join("\n").trim() };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------------------------

async function get(url, accept = "text/html,application/json;q=0.9") {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctl.signal, redirect: "follow", headers: { "user-agent": UA, accept } });
    return { ok: res.ok, status: res.status, body: res.ok ? await res.text() : "" };
  } catch (e) {
    return { ok: false, status: 0, body: "", err: e.name === "AbortError" ? "timeout" : String(e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

function viaBrowser(url) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [path.join(ROOT, "scripts", "browser-do.mjs"), "read-url", url],
      { cwd: ROOT, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        const out = String(stdout || "");
        // browser-read prints "# title\n# href\n# N chars\n\n<text>".
        const m = /^# (.*)\n# (.*)\n# \d+ chars\n\n([\s\S]*)$/.exec(out);
        resolve(err || !m ? null : { title: m[1], text: m[3].trim() });
      }
    );
  });
}

async function ghSlugFor(company) {
  try {
    const { rows } = await readTable(path.join(DATA, "boards.md"));
    const row = rows.find((r) => String(r.company || "").toLowerCase() === String(company || "").toLowerCase());
    return /greenhouse\.io\/(?:v1\/boards\/)?([^/?#]+)/i.exec(row?.endpoint || "")?.[1] || "";
  } catch {
    return "";
  }
}

export async function fetchJd(url, { company = "", browser = false, fetcher = get, browserFetch = viaBrowser } = {}) {
  const tries = [];
  const plan = apiPlan(url, /gh_jid=/i.test(url) ? await ghSlugFor(company) : "");
  if (plan) {
    const r = await fetcher(plan.url, "application/json");
    let got = null;
    if (r.ok) {
      try {
        got = fromApi(plan.kind, JSON.parse(r.body), plan.jobId);
      } catch {
        /* not JSON */
      }
    }
    if (got && got.text.length >= THIN_CHARS) return { ...got, via: `${plan.kind}-api` };
    tries.push(`${plan.kind}-api: ${r.ok ? (got ? `thin (${got.text.length} chars)` : "no posting in response") : r.err || `HTTP ${r.status}`}`);
  }
  const page = await fetcher(url);
  let best = null;
  if (page.ok) {
    const isLinkedIn = /linkedin\.com/i.test(url);
    const cands = [
      ["json-ld", jsonLdJobPosting(page.body)],
      ["linkedin-public", isLinkedIn ? linkedinDescription(page.body) : null],
      // Not for LinkedIn: a removed LinkedIn job redirects to a search page, whose text is long
      // and says nothing about the job.
      ["page-text", isLinkedIn ? null : { title: (/<title>([^<]*)/i.exec(page.body)?.[1] || "").trim(), text: htmlToText(page.body) }],
    ].filter(([, v]) => v && v.text);
    const structured = cands.some(([via, v]) => via !== "page-text" && v.text.length >= THIN_CHARS);
    const closed = closedSignal(page.body, { whole: !structured });
    if (closed && !structured) {
      return { title: "", text: "", via: "closed", thin: true, closed: true, tries: [`page says the job is gone: "${closed.slice(0, 120)}"`] };
    }
    for (const [via, v] of cands) {
      if (v.text.length >= THIN_CHARS) return { ...v, via, ...(closed ? { closed: true, tries: [`page also says: "${closed.slice(0, 120)}"`] } : {}) };
      if (!best || v.text.length > best.text.length) best = { ...v, via };
    }
    tries.push(
      isLinkedIn && !cands.length
        ? "http: no LinkedIn description block (the job was probably removed and redirected to search)"
        : `http: thin (${best ? best.text.length : 0} chars; the page is probably rendered by JavaScript)`
    );
  } else {
    tries.push(`http: ${page.err || `HTTP ${page.status}`}`);
  }
  if (browser) {
    const b = await browserFetch(url);
    if (b && b.text.length >= THIN_CHARS) return { ...b, via: "browser" };
    tries.push(`browser: ${b ? `thin (${b.text.length} chars)` : "failed"}`);
  }
  return { ...(best || { title: "", text: "" }), via: best?.via || "none", thin: true, tries };
}

// ---------------------------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------------------------

export const cachePath = (id) => path.join(CACHE, `${assertSafeId(id)}.txt`);

export async function readCache(id) {
  try {
    const raw = await fs.readFile(cachePath(id), "utf8");
    const head = Object.fromEntries([...raw.matchAll(/^# (\w+): (.*)$/gm)].map((m) => [m[1], m[2]]));
    return { ...head, text: raw.replace(/^(# .*\n)+\n?/, "") };
  } catch {
    return null;
  }
}

async function writeCache(id, url, r) {
  await fs.mkdir(CACHE, { recursive: true });
  const head = [
    `# url: ${url}`,
    `# fetched: ${new Date().toISOString()}`,
    `# via: ${r.via}`,
    `# title: ${String(r.title || "").replace(/\s+/g, " ").trim()}`,
    `# chars: ${r.text.length}`,
    `# thin: ${r.thin ? "yes" : "no"}`,
    `# closed: ${r.closed ? "yes" : "no"}`,
  ].join("\n");
  const file = cachePath(id);
  await fs.writeFile(file + ".tmp", `${head}\n\n${r.text.slice(0, MAX_CHARS)}\n`);
  await fs.rename(file + ".tmp", file);
  return file;
}

async function cacheOne({ id, url, company, text = null }, opts) {
  const rel = (p) => path.relative(ROOT, p);
  if (text != null) {
    const r = { title: "", text: text.trim(), via: "pasted", thin: text.trim().length < THIN_CHARS };
    return { id, ok: !r.thin, via: r.via, chars: r.text.length, path: rel(await writeCache(id, url || "", r)), ...(r.thin ? { thin: true } : {}) };
  }
  if (!url) return { id, ok: false, error: "no job_url" };
  const cached = await readCache(id);
  const ageDays = cached?.fetched ? (Date.now() - Date.parse(cached.fetched)) / 86_400_000 : Infinity;
  if (!opts.refresh && cached && cached.thin === "no" && ageDays < opts.maxAge) {
    return { id, ok: true, via: `cache (${cached.via})`, chars: cached.text.trim().length, path: rel(cachePath(id)) };
  }
  const r = await fetchJd(url, { company, browser: opts.browser });
  const file = await writeCache(id, url, r);
  return {
    id, ok: !r.thin && !r.closed, via: r.via, chars: r.text.length, path: rel(file),
    ...(r.thin ? { thin: true } : {}), ...(r.closed ? { closed: true } : {}), ...(r.tries ? { tries: r.tries } : {}),
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (n) => {
    const i = argv.indexOf(n);
    return i >= 0 ? argv[i + 1] : null;
  };
  const opts = { refresh: argv.includes("--refresh"), browser: argv.includes("--browser"), maxAge: Number(flag("--max-age") || 7) };
  const valued = new Set(["--url", "--id", "--text-file", "--max-age"]);
  const ids = argv.filter((a, i) => !a.startsWith("--") && !valued.has(argv[i - 1]));

  const jobs = [];
  if (flag("--text-file") || flag("--url")) {
    const id = flag("--id");
    if (!id) throw new Error("--url / --text-file need --id <name> for the cache file");
    const text = flag("--text-file") ? await fs.readFile(flag("--text-file"), "utf8") : null;
    jobs.push({ id, url: flag("--url") || "", text });
  }
  if (ids.length || argv.includes("--untriaged")) {
    const props = (await readRecordDir(path.join(DATA, "proposals"))).map((r) => r.data).filter((d) => d && d.id);
    const want = argv.includes("--untriaged")
      ? props.filter((d) => String(d.status || "proposed") === "proposed" && !d.triage_bucket)
      : ids.map((id) => props.find((d) => d.id === id) || { id, missing: true });
    for (const d of want) {
      if (d.missing) {
        process.stdout.write(JSON.stringify({ id: d.id, ok: false, error: "no such proposal" }) + "\n");
        continue;
      }
      jobs.push({ id: d.id, url: d.job_url, company: d.company });
    }
  }
  if (!jobs.length) throw new Error("nothing to fetch. Usage: see the header of scripts/fetch-jd.mjs");

  for (const [i, job] of jobs.entries()) {
    let out;
    try {
      out = await cacheOne(job, opts);
    } catch (e) {
      out = { id: job.id, ok: false, error: String(e.message || e) };
    }
    process.stdout.write(JSON.stringify(out) + "\n");
    // Polite pacing between live fetches: one page per posting, human-speed (AGENT-RULES §7).
    if (i < jobs.length - 1 && !String(out.via || "").startsWith("cache")) await new Promise((r) => setTimeout(r, 1500));
  }
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
    process.stderr.write(`fetch-jd: ${e?.message || e}\n`);
    process.exit(1);
  });
}

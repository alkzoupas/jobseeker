#!/usr/bin/env node
// Guards scripts/board-scan.mjs without touching the network: every adapter against a trimmed copy
// of the payload its board really serves, and the three filters against the cases that went wrong
// while it was being built.
//
// The filters fail QUIETLY in both directions, which is why they get tests rather than eyeballs:
//   * too loose, and role-scout drowns — "management" once stemmed to "manager", so "Senior Software
//     Engineer, Capacity Management" passed as an Engineering Manager role;
//   * too tight, and a real role never reaches anyone — Stripe's "N/A" location once dropped an ML
//     fraud-detection EM role as "not in the Bay Area".
//
//   npm run test:board-scan

import {
  stem, phraseInTitle, titleFilter, locationFilter, ADAPTERS, adapterFor, readBoard,
  makeDeduper, possiblyClosed, workdayPosted, ageDays, titleShape, titleVocab, tryTitles,
} from "./board-scan.mjs";
import { keepNotes } from "./board-sweep.mjs";

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
};

// ---- title ----
console.log("title matching");
check("engineering/engineer/engineers share a stem", stem("engineering") === stem("engineer") && stem("engineers") === stem("engineer"));
check("management is NOT manager", stem("management") !== stem("manager"));
check("engine is NOT engineer", stem("engine") !== stem("engineer"));
check("word order does not matter", phraseInTitle("Engineering Manager", "Manager, Machine Learning Engineering"));
check("'Engineer Manager' typo still matches", phraseInTitle("Engineering Manager", "Engineer Manager, HR Applications"));
check("Capacity Management IC role does not match", !phraseInTitle("Engineering Manager", "Senior Software Engineer, Capacity Management"));
check("Engine Networking PM does not match", !phraseInTitle("Engineering Manager", "Senior Product Manager, Engine Networking"));

const tf = titleFilter({ include: ["Engineering Manager"], exclude: ["Legal"] });
check("plain EM kept", tf("Senior Engineering Manager, Trust & Safety").ok);
check("Program Manager rejected as other family", !tf("Engineering Program Manager").ok && tf("Engineering Program Manager").near);
check("Product Manager, X Engineering rejected", !tf("Product Manager, Financial Engineering").ok);
check("intern excluded by default", !tf("Engineering Manager Intern").ok);
check("config exclude applies", !tf("Legal Engineering Manager").ok);
check("'Manager, Software Engineering' kept", tf("Manager, Software Engineering (Payments)").ok);
check("marketing is caught after stemming (Product Marketing Manager ≠ T&S Manager)", !titleFilter({ include: ["Trust and Safety Manager"] })("Sr. Product Marketing Manager, Trust & Safety").ok);
check("a real T&S Manager still matches", titleFilter({ include: ["Trust and Safety Manager"] })("Manager, Trust & Safety").ok);
check("T&S OPERATIONS Manager is another family unless asked for", !titleFilter({ include: ["Trust and Safety Manager"] })("Trust & Safety Operations Manager").ok);
check("Program Manager as a TARGET still works", titleFilter({ include: ["Program Manager"] })("Technical Program Manager").ok);

// ---- location ----
console.log("location matching");
const lf = locationFilter(["San Francisco Bay Area", "Remote US"]);
const v = (locations, extra = {}) => lf({ locations, ...extra }).verdict;
check("Bay Area city (Santa Clara, Workday style)", v(["US, CA, Santa Clara"]) === "match");
check("literal 'San Francisco Bay Area'", v(["San Francisco Bay Area"]) === "match");
check("'Strava SF' via sf alias", v(["Strava SF"]) === "match");
check("one of several cities", v(["New York, NY; Sunnyvale, CA"]) === "match");
check("Remote - US", v(["Remote - US"]) === "match");
check("United States - Remote", v(["United States - Remote"]) === "match");
check("Remote (Austin, TX) via state code", v(["Remote (Austin, TX)"]) === "match");
check("Remote - Canada dropped", v(["Remote - Canada"]) === "no");
check("Remote - India dropped", v(["Remote - India"]) === "no");
check("'Canada - Remote (ON, AB...)' dropped", v(["Canada - Remote (ON, AB, BC, or NS Only)"]) === "no");
check("New York, NY dropped (city, not region)", v(["New York, NY"]) === "no");
check("Washington, DC dropped", v(["Washington, DC"]) === "no");
check("San Francisco, CA is not Canada", v(["San Francisco, CA"]) === "match");
check("'N/A' is unknown, never dropped", v(["N/A"]) === "unknown");
check("'2 Locations' is unknown", v(["2 Locations"]) === "unknown");
check("'North America' region-only → unknown", v(["North America"]) === "unknown");
check("'United States' region-only → unknown", v(["United States"]) === "unknown");
check("no location at all → unknown", v([]) === "unknown");
check("bare Remote → match, flagged", lf({ locations: ["Remote"] }).flag === "remote region unstated");
check("remote flag + US country", v([], { remote: true, country: "US" }) === "match");
check("London dropped", v(["London, UK"]) === "no");
check("no criteria → everything matches", locationFilter([])({ locations: ["Mars"] }).verdict === "match");

// ---- adapters ----
console.log("adapters");
const endpoints = {
  "https://boards-api.greenhouse.io/v1/boards/discord/jobs": "greenhouse",
  "api.greenhouse.io/v1/boards/kodiak/jobs": "greenhouse",
  "https://job-boards.greenhouse.io/doubleverify": "greenhouse",
  "https://boards-api.greenhouse.io/v1/boards/twilio/jobs?content=true": "greenhouse",
  "https://api.lever.co/v0/postings/waabi?mode=json": "lever",
  "https://api.ashbyhq.com/posting-api/job-board/skydio": "ashby",
  "https://aurora.tech/api/jobs-index": "jobs-index",
  "https://apply.workable.com/api/v1/widget/accounts/huggingface": "workable",
  "POST https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/NVIDIAExternalCareerSite/jobs body {}": "workday",
  "https://ats.rippling.com/cargosprint/jobs": "rippling",
  "https://bunq.recruitee.com/api/offers/": "recruitee",
  "https://workwithus.pinpointhq.com/postings.json": "pinpoint",
  "https://api.smartrecruiters.com/v1/companies/BoschGroup/postings?limit=10": "smartrecruiters",
  "https://starship.teamtailor.com/jobs.json": null,
};
for (const [ep, want] of Object.entries(endpoints)) check(`adapterFor ${ep.slice(0, 60)}`, adapterFor(ep) === want, `got ${adapterFor(ep)}`);
check(
  "greenhouse plan normalises host, drops ?content=true",
  ADAPTERS.greenhouse.plan("https://boards-api.greenhouse.io/v1/boards/twilio/jobs?content=true")[0].url === "https://boards-api.greenhouse.io/v1/boards/twilio/jobs" &&
    ADAPTERS.greenhouse.plan("https://job-boards.greenhouse.io/doubleverify")[0].url === "https://boards-api.greenhouse.io/v1/boards/doubleverify/jobs"
);

const gh = ADAPTERS.greenhouse.parse({
  jobs: [{ title: "Engineering Manager", location: { name: "San Francisco Bay Area" }, absolute_url: "https://job-boards.greenhouse.io/discord/jobs/1", requisition_id: "R-107406", first_published: "2026-09-15T12:52:11-04:00" }],
});
check("greenhouse parse", gh[0].title === "Engineering Manager" && gh[0].req_id === "R-107406" && gh[0].posted_at === "2026-09-15" && gh[0].locations[0] === "San Francisco Bay Area");

const lv = ADAPTERS.lever.parse([
  { text: "Senior Manager, ML", categories: { location: "Toronto, ON", allLocations: ["Toronto, ON", "Remote - US"] }, workplaceType: "remote", country: "US", hostedUrl: "https://jobs.lever.co/x/abc", createdAt: 1766095153993 },
]);
check("lever parse (allLocations, remote, epoch ms)", lv[0].locations.length === 2 && lv[0].remote === true && lv[0].posted_at === "2025-12-18");

const ash = ADAPTERS.ashby.parse({
  jobs: [
    { title: "EM", location: "San Mateo, California, United States", secondaryLocations: [{ location: "Remote" }], isListed: true, workplaceType: "Hybrid", address: { postalAddress: { addressCountry: "United States" } }, jobUrl: "https://jobs.ashbyhq.com/s/1", publishedAt: "2026-06-04T17:36:23.056+00:00" },
    { title: "Hidden", isListed: false },
  ],
});
check("ashby parse skips unlisted, keeps secondary locations", ash.length === 1 && ash[0].locations.includes("Remote") && ash[0].remote === null && ash[0].country === "United States");

const idx = ADAPTERS["jobs-index"].parse({ jobs: [{ title: "L&D Lead", locations: ["Pittsburgh, PA"], isRemote: true, applyLink: "https://aurora.tech/careers?ashby_jid=1", publishedDate: "2026-09-22" }] });
check("jobs-index (Aurora) parse", idx[0].url.includes("ashby_jid") && idx[0].posted_at === "2026-09-22");

const wk = ADAPTERS.workable.parse({ jobs: [{ title: "EM", telecommuting: true, url: "https://apply.workable.com/j/X", published_on: "2026-07-30", country: "France", city: "Paris", locations: [{ country: "France", city: "Paris", region: "Île-de-France" }] }] });
check("workable parse", wk[0].locations[0] === "Paris, Île-de-France, France" && wk[0].remote === true);

const wdStep = ADAPTERS.workday.plan("POST https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/NVIDIAExternalCareerSite/jobs body {x}", ["Engineering Manager"]);
check("workday plan: POST, one group per phrase, paged", wdStep.length === 5 && wdStep[0].method === "POST" && JSON.parse(wdStep[1].body).offset === 20 && wdStep[0].group === "Engineering Manager");
const wd = ADAPTERS.workday.parse(
  { jobPostings: [{ title: "Engineering Manager, LLM Performance", externalPath: "/job/US-CA-Santa-Clara/EM_JR2019950", locationsText: "US, CA, Santa Clara", postedOn: "Posted 30+ Days Ago", bulletFields: ["JR2019950"] }] },
  {},
  wdStep[0]
);
check("workday parse builds public URL + req id", wd[0].url === "https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/EM_JR2019950" && wd[0].req_id === "JR2019950");
const now = new Date("2026-09-23T12:00:00Z");
check("workday relative dates", workdayPosted("Posted Today", now) === "2026-09-23" && workdayPosted("Posted Yesterday", now) === "2026-09-22" && workdayPosted("Posted 30+ Days Ago", now) === "2026-08-24" && workdayPosted("", now) === "");

const html = `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
  props: { pageProps: { dehydratedState: { queries: [{ state: { data: { items: [{ id: "d9", name: "Engineering Manager (Python)", url: "https://ats.rippling.com/cargosprint/jobs/d9", locations: [{ name: "Remote (United States)", country: "United States", workplaceType: "REMOTE" }] }] } } }] } } },
})}</script></html>`;
const rp = ADAPTERS.rippling.parse(html);
check("rippling parse from __NEXT_DATA__", rp.length === 1 && rp[0].remote === true && rp[0].locations[0] === "Remote (United States)");
check("rippling without page data → null (error, not empty)", ADAPTERS.rippling.parse("<html></html>") === null);

const rc = ADAPTERS.recruitee.parse({ offers: [{ title: "Guide", location: "İstanbul", locations: [{ city: "İstanbul", country: "Türkiye" }], remote: false, careers_url: "https://c/o/g", published_at: "2026-09-23 09:10:19 UTC" }] });
check("recruitee parse", rc[0].posted_at === "2026-09-23" && rc[0].url === "https://c/o/g");
const pp = ADAPTERS.pinpoint.parse({ data: [{ title: "Counsel", url: "https://w.pinpointhq.com/en/postings/1", workplace_type: "remote", location: { city: "London", name: "Remote" } }] });
check("pinpoint parse", pp[0].remote === true && pp[0].locations[0] === "London");
const sr = ADAPTERS.smartrecruiters.parse({ content: [{ id: "7", name: "GenAI Engineer", refNumber: "REF1", company: { identifier: "BoschGroup" }, releasedDate: "2026-09-23T15:21:39.129Z", location: { fullLocation: "Braga, , Portugal", remote: false, country: "pt" } }] });
check("smartrecruiters parse", sr[0].url === "https://jobs.smartrecruiters.com/BoschGroup/7" && sr[0].req_id === "REF1");
check("unexpected shape → null, not []", ADAPTERS.greenhouse.parse({ error: "x" }) === null && ADAPTERS.lever.parse({}) === null);

// ---- readBoard ----
console.log("readBoard");
const reply = (status, body) => async () => ({ ok: status === 200, status, body: typeof body === "string" ? body : JSON.stringify(body) });
let r = await readBoard({ endpoint: "https://boards-api.greenhouse.io/v1/boards/x/jobs" }, [], reply(404, ""));
check("404 → error with status", r.state === "error" && r.why === "HTTP 404");
r = await readBoard({ endpoint: "https://boards-api.greenhouse.io/v1/boards/x/jobs" }, [], reply(200, { nope: 1 }));
check("200 with wrong shape → error, never an empty board", r.state === "error" && /expected shape/.test(r.why));
r = await readBoard({ endpoint: "https://starship.teamtailor.com/jobs.json" }, []);
check("no adapter → unsupported", r.state === "unsupported");
r = await readBoard({ endpoint: "https://boards-api.greenhouse.io/v1/boards/x/jobs" }, [], reply(200, { jobs: [] }));
check("empty board is ok with zero postings", r.state === "ok" && r.postings.length === 0 && r.partial === false);

// Search paging: a short page ends that phrase; a failure on a later page keeps what was read.
let calls = 0;
const wdFetch = async (step) => {
  calls++;
  const { offset, searchText } = JSON.parse(step.body);
  if (searchText === "B" && offset === 20) return { ok: false, status: 500, body: "" };
  const n = searchText === "A" ? (offset === 0 ? 20 : 3) : 20;
  const jobPostings = Array.from({ length: n }, (_, i) => ({ title: `${searchText} ${offset + i}`, externalPath: `/job/${searchText}-${offset + i}`, locationsText: "US" }));
  return { ok: true, status: 200, body: JSON.stringify({ jobPostings }) };
};
r = await readBoard({ endpoint: "POST https://t.wd1.myworkdayjobs.com/wday/cxs/t/Site/jobs body {}" }, ["A", "B"], wdFetch);
check("paging stops on a short page, survives a failed later page", r.state === "ok" && r.partial === true && r.postings.length === 23 + 20 && calls === 4, `postings=${r.postings.length} calls=${calls}`);

// ---- dedup ----
console.log("dedup");
const keys = {
  applications: [{ id: "app_1", company: "Acme", role: "Engineering Manager, Payments", kind: "application", status: "Applied", req_ids: ["R555"], skip: true }],
  proposals: [
    { id: "prop_1", company: "Stripe", role: "Engineering Manager, Radar", status: "dismissed", job_url: "https://x/stripe/1", req_ids: [], skip: true },
    { id: "prop_2", company: "Discord", role: "Engineering Manager, Safety", status: "proposed", job_url: "https://job-boards.greenhouse.io/discord/jobs/9?gh_src=abc", req_ids: [], skip: false },
  ],
  seen_req_ids: { R555: [{ id: "app_1", company: "Acme", status: "Applied", skip: true }] },
};
const dd = makeDeduper(keys);
check("same URL (query string ignored)", dd("Discord", { title: "Anything", url: "https://job-boards.greenhouse.io/discord/jobs/9", locations: [] }).drop);
check("same company+title, parenthetical board name", dd("Stripe", { title: "Engineering Manager, Radar", url: "https://y", locations: [] }).drop);
check("dismissed reason says dismissed", /dismissed/.test(dd("Stripe", { title: "Engineering Manager, Radar", url: "https://y", locations: [] }).why));
check("same req id at the same company", dd("Acme", { title: "Totally new title", url: "https://z", req_id: "R-555", locations: [] }).drop);
check("same req id at a DIFFERENT company is not a dup", !dd("Globex", { title: "EM", url: "https://z", req_id: "R-555", locations: [] }).drop);
const rep = dd("Acme", { title: "Senior Engineering Manager, Payments", url: "https://new", locations: [] });
check("reworded repost of an application is flagged, not dropped", !rep.drop && rep.repost_of?.id === "app_1");
const exactRepost = dd("Acme", { title: "Engineering Manager, Payments", url: "https://reposted", req_id: "R-999", locations: [] });
check("exact-title repost with new URL + req id is KEPT and flagged", !exactRepost.drop && exactRepost.repost_of?.id === "app_1");
const ddLead = makeDeduper({ applications: [{ id: "lead_1", company: "Initech", role: "Engineering Manager, ML", kind: "lead", status: "", req_ids: [] }], proposals: [], seen_req_ids: {} });
const leadHit = ddLead("Initech", { title: "Engineering Manager, ML", url: "https://i", locations: [] });
check("posting matching a LEAD is flagged", !leadHit.drop && leadHit.repost_of?.id === "lead_1");
check("new role passes clean", !dd("Acme", { title: "Engineering Manager, Identity", url: "https://n", locations: [] }).drop);

// ---- possibly closed ----
console.log("possibly closed");
const props = [
  { id: "p1", company: "Nametag", role: "Engineering Manager", status: "proposed", job_url: "https://job-boards.greenhouse.io/nametag/jobs/1" },
  { id: "p2", company: "Nametag", role: "Director, Safety", status: "proposed", job_url: "https://elsewhere/2" },
  { id: "p3", company: "NVIDIA", role: "Gone Role", status: "proposed", job_url: "" },
  { id: "p4", company: "Nametag", role: "Old", status: "dismissed", job_url: "" },
];
const boardRes = [
  { company: "Nametag", state: "ok", partial: false, adapter: "greenhouse", postings: [{ title: "Senior Engineering Manager", url: "https://job-boards.greenhouse.io/nametag/jobs/1" }, { title: "Other", url: "https://o" }] },
  { company: "NVIDIA", state: "ok", partial: true, adapter: "workday", postings: [{ title: "x", url: "https://x" }] },
];
const pc = possiblyClosed(props, boardRes);
check("missing live proposal on a full board is reported", pc.some((x) => x.id === "p2"));
check("present by URL is not reported", !pc.some((x) => x.id === "p1"));
check("search-based (partial) boards are never used", !pc.some((x) => x.id === "p3"));
check("dismissed proposals are ignored", !pc.some((x) => x.id === "p4"));

// ---- title research ----
console.log("title research");
check("shape drops level + specialisation", titleShape("Senior Engineering Manager, Payments") === "engineering manager");
check("shape keeps the job when the lead segment is only a head noun", titleShape("Manager II, Engineering - Connections") === "manager, engineering");
check("shape keeps 'Chief of Staff' intact", titleShape("Chief of Staff, Co-CEO") === "chief of staff");
check("shape drops bracketed text", titleShape("Director of Engineering (Remote)") === "director of engineering");
const vrows = [
  { company: "A", title: "Director of Engineering, Data" },
  { company: "B", title: "Senior Director of Engineering" },
  { company: "C", title: "Product Marketing Manager" },
  { company: "D", title: "Software Engineer" },
];
const voc = titleVocab(vrows, { related: ["Engineering Manager"] });
check("vocab: related shapes share a non-head role word", voc.related[0]?.shape === "director of engineering" && voc.related[0].companies === 2);
check("vocab: unrelated leadership titles go to `other`", voc.other.some((o) => o.shape === "product marketing manager"));
check("vocab: titles with no head noun are ignored", ![...voc.related, ...voc.other].some((o) => o.shape === "software engineer"));
const tt = tryTitles(
  [{ company: "A", title: "Tech Lead Manager, Cards" }, { company: "B", title: "Engineering Program Manager" }, { company: "C", title: "Tech Lead Manager Intern" }],
  ["Tech Lead Manager", "Engineering Manager"]
);
check("try-titles counts what the phrase would add", tt[0].new_postings === 1 && tt[0].samples[0].startsWith("A —"));
check("try-titles applies the real filter rules (family + default excludes)", tt[1].new_postings === 0);

check("ageDays", ageDays("2026-09-20", now) === 3 && ageDays("", now) === null);

check("slug-style location (\"san_francisco\") matches the Bay Area", locationFilter(["San Francisco Bay Area", "Remote US"])({ locations: ["san_francisco"] }).verdict === "match");

console.log("board-sweep notes");
const human = "Eightfold API is 403 to scripts; use the /careers UI.";
const v1 = keepNotes(human, "2026-09-24 board-sweep: READ IN CHROME");
check("sweep keeps a hand-written note", v1 === `2026-09-24 board-sweep: READ IN CHROME | prev: ${human}`);
const v2 = keepNotes(v1, "2026-09-25 board-sweep: hit a login wall");
check("next sweep replaces its own verdict, keeps the human note once", v2 === `2026-09-25 board-sweep: hit a login wall | prev: ${human}`);
check("a sweep-only note does not pile up", keepNotes("2026-09-24 board-sweep: old", "2026-09-25 board-sweep: new") === "2026-09-25 board-sweep: new");
check("empty notes stay just the verdict", keepNotes("", "x") === "x" && keepNotes(undefined, "x") === "x");

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);

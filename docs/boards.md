# Job-board field notes

Board-specific navigation quirks learned the hard way. **role-scout reads this when it needs to
work a specific board** — it lives here rather than in the agent prompt so it can grow without
making every scout invocation carry all of it.

**Add to this file whenever you learn a new board's behaviour.** A quirk that costs one run is
worth a paragraph here.

> ## Look here SECOND. The registry comes first.
>
> `node server/record.mjs list-boards` is the **structured** index — one row per company with its
> ATS, exact endpoint, and an `access` verdict (`json` / `html` / `browser` / `blocked` / `none`).
> Query that before scouting, and `upsert-board` after; see AGENT-RULES §14.
>
> This file is for the things that need a paragraph rather than a cell: rotating tokens, exact API
> call shapes, SPA traps, search-field behaviour. The two are complements — the registry answers
> "where is it and can I read it?", this answers "how do I actually work it?".
>
> Note the sections below are organised by *when* they were learned, which is why the registry
> exists: chronological prose is not a lookup.

## "Browser-only" no longer means "not covered"

A board marked `browser` or `blocked` is **read automatically now**. `scripts/board-sweep.mjs` opens
each one in the user's real Chrome over Apple Events, extracts the visible text, and reclassifies it
— 15 boards per run, oldest `last_verified` first, wired into `scripts/job-run.sh`.

```bash
npm run board:sweep -- --dry-run          # what it would read, writes nothing
npm run board:sweep -- --max 10           # drain 10
node scripts/browser-do.mjs read-url URL  # one page, through the same path
```

**Why it had to be built:** role-scout's only browser tools were `mcp__claude-in-chrome__*`, which an
interactive Claude Code session injects and the scheduled `claude -p` run does not have. The agent
was told to "switch to Chrome" and could not, so the queue grew to 45 boards and every digest
reported the gap instead of closing it.

**Read the cache before fetching anything.** Each swept board lands in
`data/.board-cache/<company>.txt` with a `# fetched:` timestamp in its header. Anything older than
~3 days is stale — re-read it rather than proposing roles that have since closed.

**What the sweep will NOT do**, so a person still has to:

- Guess a URL. Rows whose endpoint is prose ("unknown — cyberark.wd1 … returns 422") or empty are
  reported as skipped, not opened.
- Open single LinkedIn postings. Those are one req, already verified when written, and re-opening
  dozens is what gets rate-limited.
- Believe a page that loaded. A Chrome error interstitial is thousands of characters of text —
  reading it as content filed Microsoft as "readable, 7123 chars" when those chars were *"Your
  connection is not private"*. Chrome error pages, thin bodies (<200 chars) and login/consent walls
  are each detected and recorded as what they are.
- Click anything. `browser.mjs` exposes navigation and extraction only, deliberately. Boards whose
  openings sit behind a **"View Openings"** button or a lazy load (Tarabut, Temenos, Pyypl) return a
  real careers page with no listings on it. The cache header says
  `# job-title-shaped lines: N — LOOKS LIKE A LANDING PAGE` when that happens, and the right report
  is *"could not see the listings"*, never *"no roles"*. Those need an interactive pass.

## General SPA hazards

- **`get_page_text` caches STALE on SPA job boards.** After typing in a search box or applying a
  filter, it often still returns the *unfiltered* list — do not trust it. Use **`read_page`
  (filter: interactive)** for live job links/hrefs, or a **screenshot** to see rendered results.
- **Use the free-text location/role search field, not the checkbox filters** — checkboxes
  frequently don't register via automation. Type a location; if "United Arab Emirates" returns
  nothing useful, try **"Dubai"**.
- **Soft-404s are the default failure mode.** ATS boards return **HTTP 200 with a "we couldn't find
  the role / no longer available" body** for expired job IDs. The link "resolves" but the role is
  gone. `node scripts/check-urls.mjs` screens for these patterns automatically — run it before
  re-surfacing stored proposals.

## HN "Who is hiring?" — `scripts/hn-hiring.mjs`, no account, fully mechanical

Monthly thread, Algolia API (`hn.algolia.com/api/v1`), no key, no scraping. The script reads **every**
top-level comment in the threads it's given — not a sample — because a hand skim of a 300-500 comment
thread is indistinguishable from a thorough miss (same failure class as AGENT-RULES §13b). Run it
directly; it prints candidates, writes nothing:
```
node scripts/hn-hiring.mjs --months 3                    # default: last 3 threads
node scripts/hn-hiring.mjs --months 6 --remote-only
node scripts/hn-hiring.mjs --terms "fraud,abuse,integrity" --json
```
**A hit here is an ad, not a posting.** The comment is the employer's own copy, sometimes months old,
and it is not a live req — never cite an HN comment as a job URL. Follow every candidate to the
company's own careers page and run the full verification checklist (role-scout rule 0) before
proposing anything.

**Term vocabulary is graded, not flat.** `DEFAULT_TERMS` in the script splits into strong terms
(unambiguous outside this domain: "trust and safety", "anti-abuse", "content moderation", "aml/kyc")
and `WEAK_TERMS` (ambiguous alone: "risk", "integrity", "moderation", "bots", "ato", "adversarial",
"threat intelligence", "identity verification", "chargeback" — these fired on a cardiac-imaging
startup and a nuclear-risk think tank in testing). Use `--terms` to swap in a market-specific
vocabulary for markets that aren't T&S-flavored (e.g. an ML-leadership-shortage vocabulary was used
for the Machine Learning market: `ml platform`, `ml infra`, `applied ml`, `founding ml`, `head of
machine learning`, `llm infrastructure`).

## Wellfound (formerly AngelList Talent) — Chrome, account exists

The user has a logged-in session in their normal Chrome profile. Browse read-only, same discipline as
role-scout's LinkedIn pass (AGENT-RULES §7): low-volume, don't deep-paginate, capture company + role
+ the exact listing URL, never fabricate from a snippet. Wellfound skews early-stage/startup, which is
useful on its own for a `company_size_max`-constrained search (see `data/criteria.md`) even before
reading the role. Search by keyword (role/domain terms) and by role title, not just by market/category
filters — the category taxonomy is coarser than a real search.

## WeWorkRemotely — no account, mostly stateless

Public board, `weworkremotely.com`. Category RSS feeds work over plain fetch
(`https://weworkremotely.com/categories/remote-programming-jobs.rss` etc.) — cheap, no session, prefer
these over browsing the HTML site. Skews remote-only by construction, which is a plus for the user's
`locations` criteria but means an on-site/hybrid role at a WWR-listed company won't show up here — cross
-check the company's own careers page rather than assuming WWR is exhaustive for that employer.

## Otta / Welcome to the Jungle — Chrome, account needed, AI-matching NOT keyword search

Otta rebranded to Welcome to the Jungle. **Verified 2026-08-24: the site has moved to an AI-matching
feed, not a filterable job board.** Typing a query into the homepage search still works for a rough
count ("717 jobs found") but does not return a browsable results list — it pushes toward "Create your
profile and let matching do the sorting." The actual useful surface once signed in is
**`/en/jobs-matches`** ("New matches"), scored against **saved preferences** (role, seniority, remote,
location, salary — set once under Edit preferences) rather than a query you write per run. Read that
page's "New matches" tab (`read_page` on the results `tabpanel`, not `get_page_text` — the results
list sits in a sibling of the scoped `<article>` that `get_page_text` picks up, so it only returns the
preferences sidebar). Expect a meaningful fraction of matches to already be tracked companies, and
expect most to be role-scout's normal territory (a live opening with no distinctive domain angle)
rather than a rare find — that's a legitimate outcome, not a sign something went wrong.
**If the user has not set an account up, do not sign up on your own** — creating an account, and
entering a password, are both hard-prohibited actions regardless of instruction (not just an
AGENT-RULES §0 ask-first case) — tell the user to do it themselves and skip this source, saying so
plainly in the summary rather than silently returning fewer candidates.

## DreamWorkHQ — `dreamworkhq.com`, Chrome, account exists, AI-matching (like Otta)

Aggregator, not a company board — role-scout source, added 2026-08-24 at the user's request. The
user has an account and an uploaded resume; do not sign up or upload anything, just read.

- **The logged-in home page (`https://www.dreamworkhq.com/`) IS the matches feed** ("Your Matches"),
  no separate URL to navigate to. It's scored against the user's resume ("Matching against your
  resume"), sorted best-match-first by default, and shows a saved location filter (set once by the
  user, same idea as Otta's saved preferences) plus filter controls for match quality / posted-date /
  work-setting / seniority / function / industry / comp. Don't touch the filter checkboxes unless the
  user asked for a narrower pass — the default sort already surfaces the best matches first.
- **Each card shows company, role, location(s), salary (when disclosed), and a match-quality
  percentage** (e.g. "97%"). Treat this as a rough relevance signal, same weight as LinkedIn's
  "N connections" or a Wellfound category tag — not a substitute for role-scout's own `role_fit`/
  `cv_match` scoring.
- **Cards load 25 at a time; scroll ("Scroll to load more matches") for more** rather than assuming
  the first page is exhaustive — a market with 600+ matches has plenty past the fold, but fit drops
  off fast, so stop once matches clearly stop being relevant (roughly the 85%+ tier, looser if few
  strong hits) rather than mechanically paging through all of them.
- **⚠️ The card's own URL is not the job URL.** Clicking a card sets the page URL to
  `https://www.dreamworkhq.com/?job=<uuid>` — that's DreamWorkHQ's internal id for its detail panel,
  not a link that resolves to anything outside DreamWorkHQ. **Use the "Original" link inside the
  opened detail panel** — it points to the real posting on the vendor's own ATS (Greenhouse/Ashby/
  Lever/etc., e.g. `job-boards.greenhouse.io/discord/jobs/8637688002`). Capture and verify **that**
  URL as `job_url`, exactly like any other source (rule 0 in `.claude/agents/role-scout.md` — open
  it, confirm title + location match).
- **Heavy overlap with boards role-scout already checks directly** — DreamWorkHQ is an aggregator
  over the same ATS ecosystem (Greenhouse, Ashby, Lever, …), not a distinct source of postings. A
  Discord "Engineering Manager, Safety" card resolved to the exact same Greenhouse req already in
  the registry as `prop_q8yppb` (dismissed) — dedupe against `list-keys`/`seen_req_ids` before
  writing anything from here, same discipline as every other source.
- If the page shows a login wall or an empty/zero-match state instead of the feed described above,
  report it and fall back to the vendor-site pass — don't attempt to sign in.

## Check Point — `careers.checkpoint.com`

Search: type into "Explore by Location, Role, or Department" (**`United Arab Emirates`**, and if
thin, **`Dubai`**) + click **SEARCH JOBS** → filters via `?q=<term>`. Click the job title to land
on the posting and copy the URL from the address bar.

Posting URL shape: `careers.checkpoint.com/index.php?m=cpcareers&a=show&joborderid=<id>`

**⚠️ ROTATING TOKEN.** The `joborderid` in the URL is short-lived and rotates, while the
human-facing **"Job ID" (e.g. 26011) is stable**. A cached `joborderid` URL silently dies, serving
an **"Oops! …parameter is invalid"** page — a soft-404. Observed: the same "Sales Engineer, Dubai"
(Job ID 26011) moved from `joborderid=7315239` (dead) to `joborderid=7628139` (live).

So: **never trust a stored Check Point URL — re-derive it via the location search each time, and
set `url_volatile: "yes"`** on the proposal so the dashboard shows a red "link may expire —
re-search by Job ID <id>" warning. Put the stable Job ID in the rationale.

## Zscaler — `job-boards.greenhouse.io/zscaler`

Has a **search box AND a location field** — type into them; the `?query=` URL param does **not**
filter server-side.

Posting URL shape: `job-boards.greenhouse.io/zscaler/jobs/<id>`

Greenhouse also exposes a JSON API: `boards-api.greenhouse.io/v1/boards/zscaler/jobs` — fast and
stateless, but it may omit some region-specific roles, so don't treat it as complete.

## Greenhouse-hosted boards generally (Wiz, Zscaler, …)

Serve HTTP 200 + "we couldn't find the role" for expired IDs. Read the page body, not the status
code. Observed: a Wiz "Principal SE — EMEA" was both a dead soft-404 **and** not a Dubai role.

## KPMG Lower Gulf — Oracle Cloud recruiting (`elzw.fa.em8.oraclecloud.com`)

The candidate-experience UI is JS-rendered and returns nothing to stateless fetch, which long made
this board look browser-only. It isn't — the underlying **Oracle REST endpoint is public and
returns every live requisition as JSON**, no session required:

`elzw.fa.em8.oraclecloud.com/hcmRestApi/resources/latest/recruitingCEJobRequisitions`

Confirmed 2026-07-29: 66 live reqs. Use this instead of a browser pass. The same pattern applies to
other Oracle Cloud (`*.fa.*.oraclecloud.com`) career sites — try the `recruitingCEJobRequisitions`
resource before assuming a board needs Chrome.

**Cautionary note from the same check:** external search indexes listed an "Assistant Manager -
Cloud Cybersecurity Architect (Dubai)" that does **not** exist in the live requisition list. Search
-index corroboration is not verification — always confirm against the board's own data.

## Booz Allen Hamilton — `bah.wd1.myworkdayjobs.com`

Workday API returns `total: 0` for United Arab Emirates and Abu Dhabi. No UAE reqs exist; the
public MENA careers page 302-redirects to the global board. Don't spend a browser pass on it.

## LinkedIn

- Recommended: `linkedin.com/jobs/collections/recommended/?start=0|25|50` (paginate).
  `read_page` (interactive) yields `/jobs/view/<id>` hrefs.
  **Recommendations reorder between loads** — don't assume a stable list across pages.
- Search: `/jobs/search/?keywords=…&location=…`; the top hit's id lands in the URL as `currentJobId`.
- Exact posting URL: `linkedin.com/jobs/view/<id>/`
- Read-only and low-volume (ToS). Only one agent may drive Chrome at a time — see AGENT-RULES §13.

## Israeli-vendor ATS slugs (verified working 2026-07-29, stateless)

Statelessly readable JSON boards — far more reliable than scraping the marketing careers page:

- **Wiz** → `https://boards-api.greenhouse.io/v1/boards/wizinc/jobs` (slug is **`wizinc`**, not `wiz`).
  132 roles on 29 Jul, **zero UAE/Middle East** — every field role is `Remote - <country>` with no Gulf country.
- **Cato Networks** → `https://boards-api.greenhouse.io/v1/boards/catonetworks/jobs`. 126 roles, **zero
  UAE/MEA** despite the UAE PoPs. Retires the "MEA field org" assumption for job-board purposes.
- **Orca Security** → `orcasecurity` (8 roles). **Transmit Security** → `transmitsecurity` (18).
  **BigID** → `bigid` (15). **Salt Security** → `saltsecurity` (8). **Axonius** → `axonius` (27).
  **Torq** → `torq` (24). None have UAE/Gulf roles.
- **Silverfort** → careers page is a **Comeet lobby rendered server-side**; plain `curl` with a browser
  User-Agent returns all postings. Job links look like
  `silverfort.com/careers/co/<city-country>/<ID>/<slug>/all/` — the city is **in the URL path**, so a
  single grep gives every title+location.
- **Dream Security** → `dreamgroup.com/careers` renders all ~32 postings server-side to `curl` (title +
  location in the DOM). Comeet-backed; the `comeet-positions/<slug>` links 404 when fetched directly.
- **Tenzai** → `tenzai.one/careers` **403s WebFetch but serves `curl` + browser UA**; roles are inline
  in the HTML (title / department / location).
- **Hunters** → Comeet API `comeet.co/careers-api/2.0/company/67.007/positions?token=<40-char token>`.
  The token is in the careers-page HTML — **grep the full 40 chars**, a truncated token returns
  `400 Account uid or token are not valid`. Returned **0 open positions** on 29 Jul.
- **Prompt Security** → careers page now embeds **SentinelOne's** Greenhouse board (acquired). Its only
  Dubai req is an SDR. Don't read Prompt's page as Prompt's own roles.
- **CyberArk** → no independent board; `cyberark.com/careers` redirects to **Palo Alto Workday**.
  Query it directly:
  `POST https://paloaltonetworks.wd5.myworkdayjobs.com/wday/cxs/paloaltonetworks/panwexternalcareers/jobs`
  with `{"appliedFacets":{},"limit":20,"offset":0,"searchText":"Dubai"}`. Job detail (title + location,
  no JS) via `GET .../wday/cxs/paloaltonetworks/panwexternalcareers/job/<externalPath>` — the Workday
  **`/en-US/...` HTML URL is JS-only and returns an empty body to WebFetch**, so always verify via cxs.

### Check Point — reading the board without Chrome

`careers.checkpoint.com` **403s WebFetch** but serves plain `curl` with a browser User-Agent. The
location facet works as a query param and avoids the rotating-token problem for *listing*:

`https://careers.checkpoint.com/index.php?m=cpcareers&a=search&fa%5B%5D=country_s%3AUnited%20Arab%20Emirates`

Returns the UAE reqs with their current `joborderid`s in the HTML (29 Jul: exactly **2** — Sales
Engineer `7628139` and Field Marketing Manager `0002350`). The `&location=` param does **not** filter.

## Fintech boards — stateless slugs verified 2026-07-29

Working JSON endpoints (no session needed):

- **Chainalysis** → `api.ashbyhq.com/posting-api/job-board/chainalysis-careers` (43 roles; the
  Dubai "Solutions Architect - MECCA" IS real and live — the marketing page just renders client-side).
- **Checkout.com** → `api.ashbyhq.com/posting-api/job-board/checkout.com` (183 roles, 5 Dubai).
  Canonical posting URL: `jobs.ashbyhq.com/checkout.com/<uuid>` — prefer it over the LinkedIn mirror.
- **Binance** → `api.lever.co/v0/postings/binance?mode=json`. **Lever schema uses `text` (title) and
  `categories.location`**, not `title`/`location` — a naive parser prints `undefined`.
- **Bybit** → Greenhouse `bybit` (EU board: links are `job-boards.eu.greenhouse.io/bybit/...`).
  126 roles, heavily **Abu Dhabi**, not Dubai.
- **Careem** → Greenhouse `careem`. **Thunes** → `thunes`. **Fireblocks** → `fireblocks`.
  **OKX** → `okx`. **NICE/Actimize** → `nice` (EU board; every role is `<country> - Remote`, no UAE).
- **Tether** → `tether.recruitee.com/api/offers/` (234 offers, all "Remote job").
- **Tabby** → `tabby.pinpointhq.com/postings.json` (62 roles; `location.city` / `location.name`).
- **Visa** → Workday `visa.wd5 / visa / Visa`. **Mastercard** → `mastercard.wd1 / mastercard /
  CorporateCareers`. Both answer `POST .../wday/cxs/<tenant>/<site>/jobs` with
  `{"appliedFacets":{},"limit":20,"offset":0,"searchText":"United Arab Emirates"}`. Job detail incl.
  **full JD** via `GET .../wday/cxs/<tenant>/<site>/job/<externalPath>` — use this, the `/en-US/` HTML
  page is JS-only and returns an empty body to WebFetch.
- **Amazon Payment Services** → `amazon.jobs/en/search.json?country=ARE&result_limit=100` covers all
  Amazon/AWS UAE reqs in one call.

Dead ends found the same day (don't re-spend a pass on these statelessly):

- **Revolut** — `revolut.com/careers/` **403s both `curl` (browser UA) and WebFetch**. Needs the
  Chrome/LinkedIn route. Also has **no** Greenhouse/Lever board.
- **NymCard** — `nymcard.zohorecruit.com` no longer resolves ("does not exist"). Stored careers_url is dead.
- **ThetaRay** — Comeet lobby, JS-rendered; the page only exposes `comeet.com/jobs/thetaray/72.00F`
  and the careers-API call needs the full 40-char token which is NOT in the served HTML. Browser-only.
- **Temenos**, **Backbase**, **Rapyd** — no Greenhouse/Lever/Ashby slug and no discoverable ATS link
  in the careers-page HTML.
- **Network International** — confirmed no public careers portal; LinkedIn is the only route.

### SOLVED 2026-07-30 (fintech pass)

- **ACI Worldwide** → **Oracle Recruiting**, host `ebwg.fa.us2.oraclecloud.com`, `siteNumber=CX`
  (the "Explore Opportunities" button on `aciworldwide.com/about-aci/careers` reveals it; the older
  `aciworldwide.referrals.selectminds.com` / `careers.aciworldwide.com` hosts really are dead).
  Stateless list of every req in one call:
  `GET https://ebwg.fa.us2.oraclecloud.com/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&expand=requisitionList.secondaryLocations,flexFieldsFacet.values&finder=findReqs;siteNumber=CX,limit=200,sortBy=POSTING_DATES_DESC`
  113 reqs on 30 Jul. **Caveats:** (a) `keyword="United Arab Emirates"` returns `TotalJobsCount: 0` —
  the keyword search does NOT match location text, so **pull all reqs and filter `PrimaryLocation`
  client-side** instead. (b) `locationsFacet` only returns the **top 10** locations, so it will not
  show UAE at all — do not conclude "no UAE reqs" from the facet. (c) The `...JobRequisitionDetails`
  `finder=ById;jobId=<n>` endpoint does **not** accept the human display Id (18271 etc.) and returns
  non-JSON — use the `Id` field from the list payload.
- **Fasset** → listings are rendered **on their own site**, no external ATS; individual roles live at
  `fasset.com/careers/<position-slug>` and WebFetch on `fasset.com/careers` does return the full list
  (29 roles on 30 Jul). Not a dead end — just self-hosted.
- **Chainalysis** → **Ashby** slug `chainalysis-careers`, and the public posting API works statelessly:
  `GET https://api.ashbyhq.com/posting-api/job-board/chainalysis-careers?includeCompensation=true`
  Returns every job with `location`, `secondaryLocations` and a canonical `jobUrl`. This is the way to
  settle the recurring "Dubai req UNVERIFIED because the board is JS-driven" problem — no browser needed.

## Cybersecurity-vendor boards — stateless slugs verified 2026-07-29 (afternoon pass)

Working, no session needed:

- **Help AG** → the careers page is Elementor + AJAX (`#open-positions`, no job links in the HTML), but
  the **WordPress REST API is open**: `https://www.helpag.com/wp-json/wp/v2/openings?per_page=100`
  (35 openings on 29 Jul) and `.../wp-json/wp/v2/location` maps the location term ids
  (**15 = Dubai UAE, 322 = Abu Dhabi UAE, 325 = Fujairah UAE, 14 = Riyadh, 16 = Cairo**). The individual
  `/openings/<slug>/` page renders its body via JS — the REST record's `content` is often empty too, so
  the **title is the reliable signal**. Many Help AG reqs are suffixed **"(UAE National)"** =
  Emiratization-restricted; screen those out.
- **Sophos** → **Lever**: `api.lever.co/v0/postings/sophos?mode=json` (105 roles; UAE = 2 Dubai
  account-executive reqs only, no SE/SA). `sophos.com` **blocks curl entirely (000)** — WebFetch works
  on the careers page and is how the Lever slug was found.
- **Tenable** → Greenhouse slug is **`tenableinc`** (not `tenable`). 55 roles, zero UAE.
- **Darktrace** → Workday `darktrace.wd3 / darktrace / **DarktaceExternal**` (note the board name is
  misspelled — no "r" in "Darktace"). 1 UAE req, an SDR.
- **Qualys** → Workday `qualys.wd5 / qualys / Careers`. **`searchText:"United Arab Emirates"` returns 0
  — you must search `"Dubai"`** (4 reqs). Canonical posting URL:
  `qualys.wd5.myworkdayjobs.com/Careers/job/Dubai/<Slug>_<R-id>`.
- **Proofpoint** → Workday `proofpoint.wd5 / proofpoint / proofpointcareers`. **F5** → Workday
  `ffive.wd5 / ffive / f5jobs` (tenant is **`ffive`**, not `f5`). Neither has UAE SE/SA reqs.
- **CrowdStrike** → Workday `crowdstrike.wd5 / crowdstrike / crowdstrikecareers`. 4 UAE reqs on 29 Jul,
  **all sales/SDR/GDR — no SE/SA**.
- **OPSWAT** → Greenhouse `opswat` (84 roles). Only 2 UAE reqs at the time of checking.
- **Fortinet** → Oracle CE:
  `edel.fa.us2.oraclecloud.com/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&finder=findReqs;siteNumber=CX_2001,limit=200,sortBy=POSTING_DATES_DESC`
  — UAE reqs are account-manager only.
- **Trellix** → careers site is **WordPress + FacetWP** with a `jobs` post type:
  `careers.trellix.com/wp-json/wp/v2/jobs?per_page=100` (35 roles; `X-WP-Total` header gives the count).
  The REST `search=` param does **not** match the location, so pull all 35 and filter titles.
- **Obrela** → Workable: `apply.workable.com/api/v1/widget/accounts/obrela-security-industries-sa?details=true`
  (11 roles). Despite the Dubai Media City office, **every technical/PM req is Athens** — the only
  non-Athens ones are the DACH and UK sales managers.
- **Check Point** UAE facet query (see above) returned the same **2** reqs as the morning: Sales Engineer
  `7628139` and Field Marketing Manager `0002350`. Stable across the day.

Dead ends / blocked statelessly (don't re-spend a pass without Chrome):

- **Microsoft careers** — `gcsservices.careers.microsoft.com` fails TLS from both curl (`000`) and
  WebFetch (**cert altnames are `*.azureedge.net`**, hostname mismatch). Browser-only.
- **Google careers** — every legacy API path (`careers.google.com/api/v3|v2`,
  `/about/careers/applications/api/...`) is **404**; the `/jobs/results` page is JS-rendered and WebFetch
  truncates before the listings. Browser-only.
- **Akamai** — `akamai.com/careers` **403s curl**; the `akamaicareers.inflightcloud.com` API also 403s.
- **Thales** — Phenom-backed; `careers.thalesgroup.com/api/jobs` returns **HTTP 500** for every
  parameter shape tried. Needs the Phenom `/widgets` POST or a browser.
- **IBM** — `www-api.ibm.com/search/api/v2` accepts the POST but the location field name is unknown
  (returned 0 hits); needs the real facet name.
- **CyberKnight** — `cyberknight.tech/about-us/jobs/` is a **blog category, not a job board**: the newest
  "opening" is from **2022** (CTI Senior Sales Engineer MEA is from Nov 2020). Treat as no live board.
- No Greenhouse board exists for: sophos, darktrace, tenable, proofpoint, cyera, rapid7, varonis, vectraai
  (all `{"status":404,"error":"Job not found"}`). Confirmed zero UAE/MEA reqs on the Greenhouse boards for
  **okta** (367 roles), **cloudflare** (277), **netskope** (128), **zscaler** (298), **torq** (24).

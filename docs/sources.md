# Demand-signal source field notes

Per-source quirks for **signal-scout** (the `boards.md`/`docs/boards.md` split, mirrored for demand
signals instead of ATS boards): `data/signals/<market>.md` is the structured registry — one row per
candidate company, see the schema in `.claude/agents/signal-scout.md`. This file is the prose that
doesn't fit a table cell: how each source actually behaves, and the shared term vocabulary.

## Why demand signals are a different thing from role-scout's job

`prioritization-agent` answers "who is in market X". `role-scout` answers "what is open at those
companies **right now**". Neither can answer "who has a problem in this domain and no open req for
it yet" — a company mid-incident, mid-scaling, or that just posted an IC-level abuse/fraud/safety
role and will need a manager for it within a quarter. That needs different evidence (hiring-thread
chatter, funding/growth signals, an IC req in the right domain with no matching leadership req yet)
and different sources than an ATS. **A signal is never a job opening** — it is a reason to watch a
company, and it is promoted to a real proposal only when role-scout later finds and verifies a live
posting there (AGENT-RULES §16).

## Sources

### HN "Who is hiring?" — `scripts/hn-hiring.mjs`, no account, fully mechanical
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
company's own careers page before it goes in `data/signals/<market>.md`.

**Term vocabulary is graded, not flat.** `DEFAULT_TERMS` in the script splits into strong terms
(unambiguous outside this domain: "trust and safety", "anti-abuse", "content moderation", "aml/kyc")
and `WEAK_TERMS` (ambiguous alone: "risk", "integrity", "moderation", "bots", "ato", "adversarial",
"threat intelligence", "identity verification", "chargeback" — these fired on a cardiac-imaging
startup and a nuclear-risk think tank in testing). A weak-only match is still reported but must be
verified before it goes in the registry as anything but `strength: weak`.

### Wellfound (formerly AngelList Talent) — Chrome, account exists
The user has a logged-in session in their normal Chrome profile. Browse read-only, same discipline as
role-scout's LinkedIn pass (AGENT-RULES §7): low-volume, don't deep-paginate, capture company + role
+ the exact listing URL, never fabricate from a snippet. Wellfound skews early-stage/startup, which is
useful signal on its own for a `company_size_max`-constrained search (see `data/criteria.md`) even
before reading the role. Search by keyword (the vocabulary above) and by role title, not just by
market/category filters — the category taxonomy is coarser than the term vocabulary.

### WeWorkRemotely — no account, mostly stateless
Public board, `weworkremotely.com`. Category RSS feeds work over plain fetch
(`https://weworkremotely.com/categories/remote-programming-jobs.rss` etc.) — cheap, no session, prefer
these over browsing the HTML site. Skews remote-only by construction, which is a plus for the user's
`locations` criteria but means an on-site/hybrid role at a WWR-listed company won't show up here — cross
-check the company's own careers page rather than assuming WWR is exhaustive for that employer.

### Otta / Welcome to the Jungle — Chrome, account needed, AI-matching NOT keyword search
Otta rebranded to Welcome to the Jungle. **Verified 2026-08-24: the site has moved to an AI-matching
feed, not a filterable job board.** Typing a query into the homepage search still works for a rough
count ("717 jobs found") but does not return a browsable results list — it pushes toward "Create your
profile and let matching do the sorting." The actual useful surface once signed in is
**`/en/jobs-matches`** ("New matches"), scored against **saved preferences** (role, seniority, remote,
location, salary — set once under Edit preferences) rather than a query you write per run. Read that
page's "New matches" tab (`read_page` on the results `tabpanel`, not `get_page_text` — the results
list sits in a sibling of the scoped `<article>` that `get_page_text` picks up, so it only returns the
preferences sidebar). Treat a match here the same as a Wellfound/WWR hit: real candidates worth
scanning for the "unmet need, no leadership req yet" pattern, but since it's scored against the user's
*existing* EM/ML preferences it skews toward generic already-open EM roles — expect most matches to be
role-scout's normal territory (a live opening at a company with no distinctive domain angle) rather
than a genuine demand signal, and expect a meaningful fraction to already be tracked companies.
**If the user has not set an account up, do not sign up on your own** — creating an account, and
entering a password, are both hard-prohibited actions regardless of instruction (not just an
AGENT-RULES §0 ask-first case) — tell the user to do it themselves. If skipped, say so plainly in the
signal-scout summary rather than silently returning fewer candidates.

### Crunchbase / PitchBook — paywalled, use free substitutes instead
Neither is worth signing up for just to check headcount/funding for a `company_size_max` fit check —
`prioritization-agent` already handles that estimate (careers-page team pages, LinkedIn "N employees",
funding stage as a proxy). For signal-scout's narrower question ("is this company plausibly growing or
mid-incident"), free substitutes are enough:
- The company's own careers page — a burst of new IC reqs in the target domain within weeks IS the
  signal; no funding database needed.
- **HN "Who is hiring?" itself** — a company that has posted the same abuse-flavoured ad for several
  consecutive months is hiring against a problem it has not solved. `hn-hiring.mjs` already ranks on
  this (`months.length`).
- Company blog / engineering blog — a public incident post-mortem or a "how we do trust & safety" post
  is a direct, first-party signal, stronger than any funding number.
- LinkedIn company page "N employees" + a spot-check of open reqs (role-scout already opens this when
  scoring `cv_match`; no separate step needed).

## Output format signal-scout writes

See `.claude/agents/signal-scout.md` for the exact schema. One flat table per market file, matching
the `markets.md`/`boards.md` convention so the dashboard can parse it generically with the same
`readTable()` helper. **`data/signals/maritime-tech.md` predates this schema** — it was a one-off
interactive investigation (multiple prose tables, not the flat company-row format) for a **watch
lane** that is deliberately outside `data/criteria.md`'s `markets:` list. Leave it as-is; it is not a
signal-scout output and the dashboard renders it as a plain link rather than trying to parse its
tables as company rows.

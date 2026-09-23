# career-ops vs JobSeeker — gap analysis (2026-09-23)

Compared against `career-ops-hq/career-ops` @ `ec48f4c` (2026-09-23). It follows the earlier pass of
2026-09-10 (see `docs/roadmap.md`). That pass adopted the ATS probe list, board recheck cadence and
bounded WebSearch discovery, and parked the two items that are still open below (#1, #2).

## The two products in one paragraph each

**career-ops** is a *per-posting decision engine*: paste a job, get an A–H evaluation (fit, level,
comp, legitimacy, interview plan), a tailored PDF and a tracker row. It is very deep on everything
that happens **after** you pick a posting: fact gates on the CV, interview prep and practice, a story
bank, offer and contract review, outcome calibration. It is shallow on **capture**: no WhatsApp, no
LinkedIn messages, and Gmail only through a plugin. It has about 55 zero-token ATS scanners, 17
languages and 8 supported CLIs.

**JobSeeker** is a *memory and coordination engine*. It reads Gmail, Calendar, WhatsApp and
LinkedIn, reconciles tasks across channels, detects reposts, learns from dismissals, runs an
unattended daily job with approval gates, and has a GUI installer and dashboard. It is deep on
**capture and follow-through** and thin on **interview → offer → learning**.

So the gaps are almost all in the second half of the funnel. That is also where the value per hour
is highest once applications are out.

## Re-ranked for a search-only focus (user decision, 2026-09-23)

The user handles everything after finding a role themselves, so the post-application items below
(fact gate, interview prep, story bank, offer stage, follow-up cadence, outcome loop) are **parked**.
What matters is finding more of the right roles and fewer of the wrong ones.

**S1. Zero-token scanner for the JSON boards** (M), *new, and the biggest lever*
`data/boards.md` has **136 of 186 boards at `access: json`** (Greenhouse, Lever, Ashby,
SmartRecruiters, Workable, …). But nothing reads them mechanically. role-scout fetches them one at a
time through the LLM (`WebFetch`), and step 2 only runs for tier-1 vendors or when asked. So most
of those boards are rarely read, and reading them costs tokens. career-ops' `scan.mjs` /
`scan-ats-full.mjs` do this with no LLM involved. The equivalent here is `scripts/board-scan.mjs`
(zero-dependency, like `hn-hiring.mjs`):
- fetch every `json` board concurrently, then normalise to
  `{company, title, location, url, req_id, posted_at}`
- apply a **title filter** (positive/negative keywords derived from `criteria.md` roles and the
  `seniority` dismissal patterns) and a **location filter**
- drop anything in `list-keys` / `seen_req_ids` / dismissed, plus multi-city duplicates of the same
  req
- an optional `--since N` posted-date window
- write the survivors to a candidates file; role-scout then only scores and verifies those

The result: every board is read every run for near-zero tokens, and the LLM spends its budget on
judgement instead of fetching. It needs a `test-board-scan.mjs` with fixture payloads for each ATS.

**S2. Dealbreaker gate** (S): #1 below, unchanged.
**S3. Legitimacy flag** (S): #2 below. S1 makes `posted_at` free, so freshness stops being a guess.
**S4. Two-pass requirement scoring** (S): #9 below. It makes `cv_match` honest.
**S5. Adjacent titles** (S): #13 below. It widens S1's title filter with a confirm gate, which is
the recall knob.
**S6. Reverse discovery** (M, later): career-ops' `scan-ats-full` walks public ATS company
directories and VC portfolio seeds (YC, a16z) to find companies *not* on any market list. Our
bounded WebSearch pass covers part of this. Do it only if S1 shows the tracked list is the
bottleneck.
**S7. Warm-intro join** (S, optional): #6 below. It doesn't find roles but helps rank them (a
role where you know someone goes up).

## What we already match or beat (no action)

| career-ops feature | Ours |
|---|---|
| Repost / ghost via scan history (`detect-reposts`) | `server/match.mjs` + audit `reposted_proposals`, territory-aware |
| Discard analytics / filter tuning | `record.mjs dismissal-patterns`, which role-scout reads before proposing |
| Reply classification (`reply-watch`, `invite-match`) | inbox-tracker + chat-tracker, broader (4 channels) |
| Follow-up drafts | comms-agent with an approval gate and actual send (WhatsApp) / Gmail draft |
| Liveness check (`check-liveness`) | `scripts/check-urls.mjs` + role-scout's soft-404 rule |
| ATS auto-fill (`prepare-application`) | application-agent drives the real form, stops for approval |
| Pipeline integrity / dedup / lock | `record.mjs` single writer + lock, `test:concurrency` |
| External data dir | `JOBSEEKER_DATA_DIR` |
| Updater | `self-update` + the `sync-upstream` skill |
| Fit evaluation with gates | `job-evaluation` skill (eligibility + location gates), used by `/tailor` |

## Gaps worth adopting — ranked

Effort: S = a prompt/playbook edit or <150-line script; M = new playbook + record.mjs verb + dashboard
touch; L = multi-file feature.

### Tier 1: high value, fits the architecture cleanly

**1. Dealbreaker gate on role-scout scoring** (S), *still open from roadmap #1*
The `job-evaluation` skill already has eligibility and location gates, but only `/tailor` uses
them. role-scout's proposal score is still the pure weighted formula, so a strong `cv_match` can
outrank a violated comp floor or visa rule. Fix: read `hard_requirements` from `data/criteria.md`,
cap the score, and say `capped: <reason>` in the rationale. Reuse the skill's gate wording so the two
paths agree.

**2. Posting-legitimacy flag** (S), *still open from roadmap #2*
Borrow career-ops Block G's signal list, kept out of the numeric score:
- freshness and apply-button state
- a JD that is mostly boilerplate, has no req id, or contradicts itself (title vs requirements)
- recent layoffs or a hiring freeze in the same org
- repost count (we already have this data)
- **contractor-status wording** posing as employment ("invoice", "consultant", with no benefits
  language), which matters for UAE visa sponsorship

Output: one line in the proposal rationale, e.g. `legitimacy: caution (no req id; posted 94d)`.

**3. Deterministic fact gate on tailored CV and cover letter** (S–M)
Today factual accuracy rests on reviewer-agent, which is an LLM. career-ops' `verify-cv-facts.mjs`
is a no-LLM gate: every number, employer, title and date in the output must appear in the source
facts, plus `forbidden_phrases`. We need a zero-dependency `scripts/verify-cv-facts.mjs`:
- extract figures/percentages/years, `\textbf{}` metrics and employer/title lines from
  `output/<dir>/cv.tex` and `cover.tex`
- diff them against `templates/cv/trust_resume.tex` + `data/profile.md`, plus an optional
  allow/forbid list in config
- run it in `/tailor` Step 5, before the reviewer, and fail loudly on any unbacked claim

This is the one failure that can cost an offer after it's made.

**4. Interview prep + story bank** (M), *the largest functional gap*
We detect interview invites (calendar/inbox) and then offer nothing. Adopt a trimmed version of
`interview-prep.md` + `interview/{plan,debrief}.md`:
- `/jobseeker prep <app-id>`: company research, the likely round structure, an audience map
  (recruiter / HM / peer / panel), likely questions for each audience, and a technical checklist
  built from the JD gaps the evaluation already found
- `data/story-bank.md`: STAR + Reflection stories, grown from each prep/debrief, and every metric
  in them must trace to the CV (career-ops' `story-provenance-check`, which reuses #3)
- `/jobseeker debrief <app-id>`: questions asked, gaps, next-round intel, new stories
- Trigger: when inbox-tracker logs an interview event, add a task "prep for <co> round N".

**5. Archive the JD at tailor/apply time** (S)
Postings vanish once filled, and then you have nothing to prep or negotiate from. `/tailor` and
application-agent already hold the page text, so write it to `output/<dir>/jd.md` (plus URL, date
and req id) and link it from the application record. #4 depends on this.

**6. Warm-intro finder from LinkedIn `Connections.csv`** (S)
career-ops' `linkedin-join.mjs` joins the official LinkedIn data export against target companies.
For us it would join against `data/markets/*.md` + open proposals/applications, then write "you
know N people at <co>" into the proposal rationale and the Companies page. It uses no tokens and no
browser, and it fits the "a referral is a lead" model. It is the cheapest large gain in reply rate.

**7. Follow-up cadence that isn't "born dead"** (S)
Right now a +7d follow-up task is added only when *application-agent* applies. An application that
inbox-tracker discovers (you applied elsewhere, ATS confirmation arrived) gets none, and there is no
2nd/3rd touch. Adopt career-ops' `followup-seed` lesson:
- whenever `record.mjs` moves an application to `applied`, seed a follow-up at +7d
- when a follow-up is sent, seed the next at +7/+14 with an escalating template (first → second →
  final "closing the loop")
- stop on any reply

### Tier 2: clear value, a bit more work or narrower payoff

**8. Outcome learning loop / calibration** (M)
We learn from *dismissed proposals* but never from *application outcomes*. Record the fit score and
evaluation gaps on the application at apply time. Add a `record.mjs outcome-patterns` verb, the twin
of `dismissal-patterns`, reporting:
- conversion by score band, market, channel (referral vs cold) and seniority
- the most common gaps in rejected applications

Only report when n ≥ ~10, and say "advisory, small sample", as `calibrate.md` does. This answers "is
my scoring predicting anything?" and "do referrals actually convert better for me?"

**9. Two-pass requirement table in `job-evaluation`** (S)
In career-ops' Block B, importance is rated from the JD alone **before reading the CV**, and each
requirement is labelled `stated` / `structural` / `inferred`. Only stated or structural can be
critical. This stops the model from inflating the importance of what the candidate already has. It
is a pure prompt change to `.claude/skills/job-evaluation/SKILL.md` and makes the gaps list more
honest (which also feeds #4 and #10).

**10. Aggregate skill gaps → upskill plan** (S–M)
`upskill.mjs` counts the gaps across every evaluation and produces a tiered "learn this next" list,
diffed against the last run. That is cheap once #8 stores gaps per application.

**11. Contact discovery for a posting** (M)
`contacto.md`: identify the hiring manager, recruiter or a team peer, then draft a ≤300-character
LinkedIn note tuned to the contact type. For us it would output an **approval** for comms-agent
(LinkedIn = copy/paste). It pairs with #6.

**12. Offer stage: contract read + negotiation** (M)
- `offer-prep.md` walks the contract clause by clause (non-compete, probation, notice, IP, garden
  leave) and ends with a lawyer-questions list and an "ask the employer" list. It is descriptive and
  never gives legal advice.
- `salary-gap.mjs` compares desired, advertised and offered pay as append-only observations.
- `negotiation-roi.mjs` anchors each talking point in a verified story-bank achievement.

This is rarely used, but a single use pays for it. Adding UAE-specific framing (end-of-service,
visa/notice terms) would make it genuinely ours.

**13. Adjacent-title suggestions** (S)
`titles.md` proposes adjacent titles (e.g. SE → Solutions Architect / Technical Account Manager /
Customer Success Architect) along three axes, with a confirm gate before anything is written to
`criteria.md`. It is a cheap recall boost that sits naturally in `/jobseeker onboard` or Settings.

**14. Company process-quality signal** (S)
`rejection-latency` + `process-quality` track, per company, post-interview silence past N days and
`[process-friction]` tags such as reschedules or ghosting after the final round. We already have the
dates. Surfacing "this company went silent 21d after round 2 last time" in the proposal rationale
and the follow-up timing is almost free.

**15. Skills-assessment as its own event** (S)
HackerRank/Criteria-style tests become a stage with a deadline (`assessment-log`) instead of
free-text notes. It is a small `record.mjs` stage plus an inbox-tracker pattern.

### Tier 3: nice to have

- **ATS-parseability check** of the compiled PDF (`verify-ats`): `pdftotext` the output, then check
  reading order, that contact info is extractable, and that there are no text-in-graphics headings.
  LaTeX two-column layouts are the classic failure.
- **CV reuse for similar JDs** (`jd-similarity`): suggest an existing `output/<dir>` as the base
  when a new posting is close to one already tailored.
- **"AI-buzzword vs infrastructure" JD signal**: part of Block G, low priority for security-SE roles.
- **Funded-company discovery** (`company-funded`) as a feed into `/jobseeker markets`. Our
  bounded-WebSearch pass partly covers it.

## Deliberately not adopting

| career-ops feature | Why not |
|---|---|
| 55+ provider modules (regional boards, niche aggregators), batch workers | The breadth isn't needed. **Correction:** the core idea, a zero-token scan of our own JSON boards, *is* worth adopting (S1). The earlier "role-scout already reads them" was wrong: it reads them through the LLM, and rarely |
| Multi-CLI (Codex, Gemini, Qwen…), 17-language modes | Single user, Claude-only by design (per-agent `model:` routing depends on it) |
| Go TUI, Next.js web UI | We have the dashboard |
| Plugin system / registry, npm distribution | Conflicts with zero-dependency, single-install design |
| HTML/Playwright PDF pipeline | We're LaTeX; Playwright would be our first dependency |
| Community machinery (hired wall, manifesto, sponsors, CI bots) | Not a product need |

## Suggested order

**Search-only focus (current):** S1 → S2 → S3 → S4 → S5; S6/S7 as needed.

Original full-funnel order, kept for reference: 1 → 2 → 9 (all prompt-level, one sitting, improve every proposal immediately) → 3 → 5 → 7 → 6 →
4 → 8. Each step is independently shippable and testable. #3, #6 and #7 are deterministic scripts
that can get a `scripts/test-*.mjs` suite the same way the existing ones do.

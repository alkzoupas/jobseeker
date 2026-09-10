# JobSeeker → Hermes Migration — Phase 4 TDD Prompts

13 prompts, one per blueprint step (S1–S13). Each is **self-contained** — a fresh
agent with no other context can execute it. Execute in order; after each, run its
test and confirm green before the next. Stop and report on a red step — do not stack failures.

Shared ground truth (repeated inside each prompt where needed):
- Repo: `/Users/alkzoupas/code/jobseeker` (git, zero npm runtime deps).
- `server/record.mjs` hardcodes its data dir to `server/../data` (no env override) → tests use a scratch copy.
- `gog` v0.38.2 at `/opt/homebrew/bin/gog`; top-level `-n/--dry-run` = no mutations; `-p` plain TSV, `-j` JSON.
- `node scripts/browser-do.mjs <probe|chat-sweep|read-url|board-sweep>` routes Chrome through the `com.jobseeker.browser` LaunchAgent (permanent Apple-Events grant).
- Skills land in `~/.hermes/skills/` (Hermes home; resolve via `$HERMES_HOME`).

---

## Prompt 1 — S1: Test harness (scratch data + parity runner)

```text
You are building step S1 of the JobSeeker→Hermes migration: a test harness that lets
every later skill be dry-run against an ISOLATED copy of the data store, so no test
ever mutates Alkis's real job-search state.

CONTEXT (self-contained):
- Repo: /Users/alkzoupas/code/jobseeker. Its state lives in data/*.md (proposals/,
  applications/, markets/, communications.md, tasks.md, boards.md, spend.md, activity.md).
- ALL writes go through `node server/record.mjs <cmd> '<json>'`. CRITICAL: record.mjs
  hardcodes its data dir to path.resolve(__dirname, "..") + "/data" (server/record.mjs
  lines ~53-55). There is NO env override and no --dry-run flag. Therefore the only way
  to isolate a write is to run record.mjs from a COPY of server/ that sits next to a
  scratch data/.
- record.mjs subcommands you will exercise: upsert-proposal, upsert-application,
  add-communication, add-task, complete-task, log, list-keys, list-proposals,
  get-watermark, set-watermark. Each prints one JSON line to stdout.

BUILD (TDD):
1. First write a failing test: scripts/migration/test-harness.mjs (node, no deps) that
   asserts the harness (a) creates a scratch tree at /tmp/jobseeker-scratch/ containing
   BOTH server/ (copied) and data/ (snapshot of the repo's real data/), (b) a
   `record.mjs upsert-proposal` run from the scratch server/ writes into
   /tmp/jobseeker-scratch/data/proposals/ and NOT the repo's data/, (c) re-running the
   same upsert is idempotent (no duplicate row — record.mjs dedupes by company+role).
2. Run it → confirm RED (harness doesn't exist yet).
3. Implement scripts/migration/harness.mjs with: `snapshot` (copy server/ + data/ into
   a fresh /tmp/jobseeker-scratch, wiping any prior scratch), `run-record <args...>`
   (exec node on the SCRATCH server/record.mjs with cwd=scratch root, return stdout),
   and `diff-rows <file>` (list current rows in a scratch data file for assertions).
4. Re-run the test → GREEN. Also add a `clean` subcommand (rm -rf /tmp/jobseeker-scratch).

ACCEPTANCE: `node scripts/migration/test-harness.mjs` exits 0 with all three assertions
passing; the repo's real data/ is byte-identical before and after (git status shows no
new changes under data/). Commit scripts/migration/.
```

---

## Prompt 2 — S2: Skill `jobseeker-inbox-tracker` (Gmail + Calendar via gog)

```text
You are building step S2 of the JobSeeker→Hermes migration: a Hermes skill
`jobseeker-inbox-tracker` that tracks job-search signals from Gmail and Google Calendar,
using the `gog` CLI (replacing Claude Code's Gmail MCP connector).

CONTEXT (self-contained):
- Repo: /Users/alkzoupas/code/jobseeker. The behavior to port is defined in
  .claude/agents/inbox-tracker.md — READ IT FIRST and preserve its tracking logic
  (what counts as a job signal: interviews, referrals, stage advances, rejections,
  recruiter outreach) and its record.mjs writes. Only the TRANSPORT changes: Claude MCP
  → gog CLI.
- `gog` v0.38.2 is at /opt/homebrew/bin/gog and is authenticated (verified: it returns
  real mail/calendar). Verified syntax:
    gog gmail search "<gmail query>" -p        # e.g. "newer_than:2d" ; plain TSV rows
    gog gmail search "<query>" -j              # JSON
    gog calendar list -p                       # upcoming events, TSV: ID START END SUMMARY
  Top-level flags: -n/--dry-run (no mutations), --readonly, -a <account>.
- Writes go through `node server/record.mjs`: add-communication '<json>' (dedup by
  thread_url), add-task '<json>', complete-task <id> [note], set-watermark gmail <iso>.
- record.mjs hardcodes data dir to server/../data → TEST against a scratch copy (see
  the harness from S1: /tmp/jobseeker-scratch with server/ + data/; run record.mjs from
  the scratch server/).

BUILD (TDD):
1. Failing test: scripts/migration/test-inbox-tracker.mjs — run the skill's read path in
   dry-run against the S1 scratch snapshot; assert it (a) reads Gmail via gog search and
   Calendar via gog calendar list, (b) filters to job-relevant items only, (c) would
   write the expected add-communication/add-task rows into scratch data/ (capture the
   intended JSON payloads; assert dedup by thread_url), (d) updates the gmail watermark.
   Use gog -n/--dry-run and point record.mjs at scratch so NOTHING real is mutated.
2. RED, then implement the skill at ~/.hermes/skills/jobseeker-inbox-tracker/SKILL.md:
   frontmatter (name, description "Use when tracking job-search email/calendar signals…"),
   body = the ported inbox-tracker logic with gog commands, the job-signal filter rules
   from the playbook, and exact record.mjs write shapes. Instruct: read-only by default;
   never send email (gog has no send in this path); set the watermark only after a
   successful sweep.
3. GREEN: test passes; real data/ untouched (git status clean under data/).

ACCEPTANCE: skill file exists and is loadable; test green; no real mutation. Commit the
test (skill lives in ~/.hermes/skills, outside the repo — note that in the commit msg).
```

---

## Prompt 3 — S3: Skill `jobseeker-chat-tracker` (WhatsApp Web + LinkedIn via browser)

```text
You are building step S3 of the JobSeeker→Hermes migration: a Hermes skill
`jobseeker-chat-tracker` that reads job-relevant conversations from WhatsApp Web and
LinkedIn messaging by driving the user's logged-in Chrome through the repo's browser
bridge.

CONTEXT (self-contained):
- Repo: /Users/alkzoupas/code/jobseeker. Port the behavior from .claude/agents/chat-tracker.md
  — READ IT FIRST (unread/reply detection, job-relevance filter, what to record).
- The browser transport is `node scripts/browser-do.mjs chat-sweep [--linkedin]`. It
  routes Apple Events through the com.jobseeker.browser LaunchAgent (a stable,
  permanently-granted identity — this is why it works unattended). Verified output shape:
    WhatsApp: 19 conversations, 7 active since <iso>
      [read, active 5:10 PM] <Name> — skip — not job-related, counted only
      [unread, active …] <Name> — <preview…>
  `--dry-run` is supported. BEFORE sweeping, read data/.browser-status.json (written by
  the probe): if capabilities.read_page_content is false, DO NOT sweep — instead emit
  the file's blockers[] array VERBATIM as a Coverage note.
- Digest rule you MUST encode (AGENT-RULES §10): name the CAPABILITY, never just the app.
  Write "WhatsApp Web and LinkedIn messages were not READ — no Chrome in this run", never
  bare "WhatsApp". Never call Apple Events a fallback; cdp:down is the intended state.
- Writes: node server/record.mjs add-communication '<json>' (dedup by thread_url),
  set-watermark whatsapp|linkedin <iso>. record.mjs hardcodes data dir to server/../data
  → TEST against the S1 scratch copy (/tmp/jobseeker-scratch; run record.mjs from there).

BUILD (TDD):
1. Failing test: scripts/migration/test-chat-tracker.mjs — two cases against scratch:
   (a) browser PRESENT (.browser-status.json read_page_content=true): run chat-sweep
   --dry-run, assert it parses job-relevant conversations and would write the expected
   add-communication rows + watermark; (b) browser ABSENT (read_page_content=false):
   assert it performs NO sweep and emits the verbatim blockers[] as a Coverage string.
2. RED, then implement ~/.hermes/skills/jobseeker-chat-tracker/SKILL.md with the ported
   logic, the browser-status gate, the capability-naming rule, and exact record.mjs shapes.
3. GREEN; real data/ untouched.

ACCEPTANCE: both test cases pass (present + absent browser); skill loadable; no real
mutation. Commit the test.
```

---

## Prompt 4 — S4: Skill `jobseeker-prioritizer` (per-market)

```text
You are building step S4 of the JobSeeker→Hermes migration: a Hermes skill
`jobseeker-prioritizer` that, for ONE market, researches and ranks which companies are
worth scouting.

CONTEXT (self-contained):
- Repo: /Users/alkzoupas/code/jobseeker. Port the behavior from .claude/agents/prioritization-agent.md
  — READ IT FIRST (how it picks/ranks companies for a market, what signals it weighs).
- Markets live in data/markets/<market>.md (machine-learning, maritime-tech, physical-ai,
  trust-safety). Staleness is decided by the audit: `node server/audit.mjs "$(date +%F)"`
  returns JSON with a markets[] array; each entry has {market, last_reviewed, age_days,
  companies, stale} where stale = never reviewed or 7+ days old. The orchestrator calls
  this skill only for stale markets; the skill itself should re-check staleness and no-op
  (with a note) if the market is fresh.
- The skill's OUTPUT is the ranked company list for that market (write it where the
  playbook says — typically updating data/markets/<market>.md via record.mjs or the
  market's own writer; follow the playbook). It does NOT propose jobs (that is role-scout).
- record.mjs hardcodes data dir to server/../data → TEST against the S1 scratch copy.

BUILD (TDD):
1. Failing test: scripts/migration/test-prioritizer.mjs — for one market (use
  machine-learning), run the skill in dry-run against scratch; assert it (a) reads the
  audit staleness, (b) produces a ranked company list in the playbook's output shape into
  scratch data/markets/, (c) no-ops cleanly when the market is not stale.
2. RED, then implement ~/.hermes/skills/jobseeker-prioritizer/SKILL.md (parameterized by
   market name) with the ported ranking logic and exact write shapes.
3. GREEN; real data/ untouched.

ACCEPTANCE: test green for both stale and fresh cases; skill loadable; no real mutation.
Commit the test.
```

---

## Prompt 5 — S5: Skill `jobseeker-role-scout` part 1 (stateless sources)

```text
You are building step S5 of the JobSeeker→Hermes migration: the STATELESS half of a
Hermes skill `jobseeker-role-scout` — job discovery from sources that need no browser:
Hacker News "Who is hiring?", the a16z Jobs Gmail digest, and vendor careers sites from
the board registry. (The browser half is a separate step; do NOT include Chrome work here.)

CONTEXT (self-contained):
- Repo: /Users/alkzoupas/code/jobseeker. Port from .claude/agents/role-scout.md — READ IT
  FIRST and take ONLY the stateless source logic (HN, a16z-Gmail, vendor-careers-site
  sweep). The Chrome pass (LinkedIn/DreamWorkHQ/Wellfound/Otta) is explicitly OUT of this
  step.
- Before scouting, get the dedupe set and board registry in ONE call each:
    node server/record.mjs list-keys     -> keys with skip flags (dismissed/applied)
    node server/record.mjs list-boards   -> each company's ATS endpoint + access verdict
  Anything with skip:true must NOT be re-proposed. Open with the board registry (known ATS
  endpoints) rather than hunting careers sites; when a board is marked browser/blocked and
  pages are unreadable, skip it and report it as uncovered, and upsert-board what you learn.
- a16z Jobs source via gog: `gog gmail search "a16z" -p` (or the playbook's exact query) —
  scan for Director/EM-level T&S / anti-abuse / fraud ENGINEERING roles.
- Writes: node server/record.mjs upsert-proposal '<json>' (dedup by company+role). The
  proposal's job_url must be copied VERBATIM from the source — never reconstructed,
  shortened, or "cleaned" (query strings like ?gh_jid= are part of the address).
- record.mjs hardcodes data dir to server/../data → TEST against the S1 scratch copy.

BUILD (TDD):
1. Failing test: scripts/migration/test-role-scout-stateless.mjs — run the stateless scout
   in dry-run against scratch; assert it (a) does NOT re-propose any list-keys skip:true
   key, (b) writes proposals with verbatim job_url into scratch data/proposals/,
   (c) reports uncovered/blocked boards rather than silently dropping them.
2. RED, then implement the stateless portion in ~/.hermes/skills/jobseeker-role-scout/
   SKILL.md (structure it so the browser pass can be appended as a distinct section later).
3. GREEN; real data/ untouched.

ACCEPTANCE: test green (dedupe respected, verbatim URLs, uncovered reported); skill
loadable; no real mutation. Commit the test.
```

---

## Prompt 6 — S6: Skill `jobseeker-role-scout` part 2 (serialized browser pass)

```text
You are building step S6 of the JobSeeker→Hermes migration: the BROWSER half of the
`jobseeker-role-scout` skill — a SINGLE serialized Chrome pass over LinkedIn, DreamWorkHQ,
Wellfound, and Otta that covers ALL markets at once.

CONTEXT (self-contained):
- Repo: /Users/alkzoupas/code/jobseeker. Append to the existing skill at
  ~/.hermes/skills/jobseeker-role-scout/SKILL.md (the stateless half already exists) a
  distinct "Browser pass" section. Port the Chrome logic from .claude/agents/role-scout.md
  — READ IT FIRST.
- HARD serialization rule: this is the ONLY Chrome-driving work in the pipeline and must
  run ONCE, serially. It shares the single logged-in browser with chat-tracker; two
  Chrome drivers at once fight over tabs and burn LinkedIn rate limits. The skill must
  state that it runs in the single serialized browser slot and never concurrently with
  chat-tracker.
- Transport: `node scripts/browser-do.mjs read-url <url>` (and board-sweep for cached
  board text) via the com.jobseeker.browser LaunchAgent. GATE on data/.browser-status.json:
  if capabilities.read_page_content is false, do NOT drive Chrome — report the boards as
  uncovered (verbatim blockers[]) and stop. LinkedIn/DreamWorkHQ via saved preferences;
  Wellfound/Otta via keyword+role search across target domains.
- Writes: node server/record.mjs upsert-proposal '<json>' with VERBATIM job_url;
  upsert-board '<json>' for anything learned about a board. record.mjs hardcodes data dir
  to server/../data → TEST against the S1 scratch copy.

BUILD (TDD):
1. Failing test: scripts/migration/test-role-scout-browser.mjs — two cases against scratch:
   (a) browser PRESENT: assert the serialized pass runs once, reads cached board text /
   read-url results, and writes proposals with verbatim URLs; (b) browser ABSENT: assert
   it performs NO Chrome call and reports boards uncovered with verbatim blockers[].
2. RED, then implement the Browser-pass section in the skill (keep the stateless half intact).
3. GREEN; real data/ untouched.

ACCEPTANCE: both cases pass; the skill documents the single-serialized-slot contract; no
real mutation. Commit the test.
```

---

## Prompt 7 — S7: Skill `jobseeker-reconciler`

```text
You are building step S7 of the JobSeeker→Hermes migration: a Hermes skill
`jobseeker-reconciler` that closes open tasks proven already-done by cross-channel evidence.

CONTEXT (self-contained):
- Repo: /Users/alkzoupas/code/jobseeker. Port from .claude/agents/reconciler.md — READ IT
  FIRST (its conservative closure rules). It reads ALL open tasks and all of
  data/communications.md and closes the ones other-channel evidence proves are done (e.g. a
  WhatsApp referral already fulfilled by a sent email). It is CONSERVATIVE: when evidence
  is ambiguous, the task STAYS open. It runs in its own context (large read) and alongside
  curation — it depends only on the trackers, not on proposals.
- Writes: node server/record.mjs complete-task <id> [note] (and task-status if the playbook
  uses it). record.mjs hardcodes data dir to server/../data → TEST against the S1 scratch
  copy.

BUILD (TDD):
1. Failing test: scripts/migration/test-reconciler.mjs — seed the scratch data/ with (a) a
   task proven done by a communication in communications.md and (b) an ambiguous task; run
   the reconciler dry-run against scratch; assert it closes EXACTLY (a) and leaves (b) open.
2. RED, then implement ~/.hermes/skills/jobseeker-reconciler/SKILL.md with the ported
   conservative rules and exact record.mjs shapes.
3. GREEN; real data/ untouched.

ACCEPTANCE: test green (closes provable, leaves ambiguous); skill loadable; no real
mutation. Commit the test.
```

---

## Prompt 8 — S8: Skill `jobseeker-supervisor` (barrier)

```text
You are building step S8 of the JobSeeker→Hermes migration: a Hermes skill
`jobseeker-supervisor` — the duplicate/overlap/attention audit, run LAST (a barrier) so
its counts reflect everything the reconciler closed and scouts wrote.

CONTEXT (self-contained):
- Repo: /Users/alkzoupas/code/jobseeker. Port from .claude/agents/supervisor.md — READ IT
  FIRST (what it audits and how it phrases findings).
- Primary data source: `node server/audit.mjs "$(date +%F)"` returns JSON with keys:
  counts, duplicate_applications, duplicate_proposals, proposals_overlapping_applications,
  leads_superseded_by_application, reposted_proposals, pending_approvals, overdue_tasks,
  past_next_actions, aging_proposals, markets[], browser_debt{channels[]}, last_scheduled_run.
- NEW vs Claude: the prior-run state no longer comes from data/.job-run.status.json. It
  comes from the Hermes execution ledger — `hermes cron runs <job> --limit 5` (or the
  job's last_status). The supervisor must read that and, if the PREVIOUS run failed, say so
  at the TOP of the digest (a silently-failed run is the one thing Alkis would otherwise
  never notice). browser_debt: if any_never_swept is true or worst_days >= 2, that belongs
  in Highlights with the number.
- The supervisor does not write proposals; it produces audit findings for the digest and
  may log via node server/record.mjs log <type> <detail>. record.mjs hardcodes data dir to
  server/../data → TEST against the S1 scratch copy.

BUILD (TDD):
1. Failing test: scripts/migration/test-supervisor.mjs — seed scratch with a duplicate
   proposal pair and a failed prior-run marker; run the supervisor dry-run against scratch;
   assert it (a) flags the duplicate, (b) surfaces the prior-run failure at top,
   (c) escalates browser_debt when worst_days>=2.
2. RED, then implement ~/.hermes/skills/jobseeker-supervisor/SKILL.md with the ported audit
   logic, the Hermes-ledger prior-run read, and the digest-section mapping.
3. GREEN; real data/ untouched.

ACCEPTANCE: test green (duplicate flagged, prior-failure surfaced, debt escalated); skill
loadable; no real mutation. Commit the test.
```

---

## Prompt 9 — S9: Orchestrator prompt (the /job-run equivalent)

```text
You are building step S9 of the JobSeeker→Hermes migration: the ORCHESTRATOR PROMPT — the
text that becomes a cron job's prompt, porting .claude/commands/job-run.md. It layers on
top of the six skills (jobseeker-inbox-tracker, jobseeker-chat-tracker,
jobseeker-prioritizer, jobseeker-role-scout, jobseeker-reconciler, jobseeker-supervisor).

CONTEXT (self-contained):
- Repo: /Users/alkzoupas/code/jobseeker. READ .claude/commands/job-run.md in full and port
  its stage ordering, concurrency model, digest format, and delivery rules. This prompt is
  the "brain" that drives the skills; it does not re-implement their logic.
- CONCURRENCY MODEL (preserve exactly): NEVER more than 3 subagents in flight at once.
  Per-market work is an independent chain (prioritizer → role-scout) run concurrently with
  other markets, in waves of ≤3. Reconciliation runs alongside curation (it only needs the
  trackers). At most ONE Chrome-driving agent at a time (chat-tracker and role-scout's
  browser pass are serialized). Supervisor is the final barrier.
- STAGES: (1) Track — inbox-tracker + chat-tracker together (chat-tracker only if
  data/.browser-status.json read_page_content is true; else copy its blockers[] verbatim
  into Coverage). (2) Prioritize→curate per stale market (from audit.mjs markets[]),
  concurrent chains ≤3. (3) Reconcile alongside stage 2. (4) Supervise (barrier).
  (5) Digest.
- DIGEST FORMAT is FIXED — use it exactly:
    Update of <D Mon YYYY> Completed at <HH:MM>
    Started <HH:MM> · <N>m · <ok | partial | failed>

    Highlights
    - <decision-worthy items, most urgent first — 3 to 6 bullets>

    New Job Postings
    <Company name> - <Job posting>
    <job_url on its own line, tappable — MAXIMUM 5; "None found today." if none>

    Follow ups for Today
    - <Who> - <the ask, few words>   (up to 6, then "+N more")

    Coverage
    - <only what was NOT covered and why; omit if complete>

    System
    - <only when something the USER must fix is broken; omit if healthy>
  Rules: New Job Postings = NEW this run (exclude repost_of), ranked, ≤5; every URL copied
  VERBATIM from `node server/record.mjs list-proposals --since <date> --limit 5` (never
  reconstructed); no emojis; name the capability not the app; a broken browser is a System
  item with verbatim blockers[]; escalate persistent browser debt into Highlights.
- DELIVERY: ALWAYS write the digest to data/.last-digest.md FIRST (start with a
  `delivered: …` / `not-delivered: <reason>` line) — that is the durable copy the dashboard
  reads. Then the cron job's final response (the same digest) is delivered to chat by
  Hermes automatically. Do NOT email it. Log: node server/record.mjs log job-run "digest: …".
- HARD RULES for unattended runs: do NOT apply to anything and do NOT send follow-ups
  (those are on-demand, with approval); stay inside the 3-agent cap; if a channel isn't set
  up, note it and continue; keep it idempotent (helpers dedupe); report partial coverage
  explicitly. End by naming the three things waiting: proposals to review, follow-ups due,
  approvals pending.

BUILD (TDD):
1. Failing test: scripts/migration/test-orchestrator.mjs — a dry orchestration run against
   the S1 scratch snapshot with all six skills attached; assert it (a) emits a digest that
   matches the fixed format (section headers, ≤5 postings, URL-on-own-line), (b) writes
   data/.last-digest.md BEFORE any delivery, (c) includes Coverage/System only when
   warranted.
2. RED, then write the orchestrator prompt to docs/migration/orchestrator-prompt.md (this
   is the exact text that will be set as the cron job's prompt).
3. GREEN; real data/ untouched (the dry run writes to scratch).

ACCEPTANCE: test green (format + write-before-deliver + conditional sections); the
orchestrator-prompt.md file is complete and self-contained. Commit it + the test.
```

---

## Prompt 10 — S10: Pre-run script (thin hardening wrapper)

```text
You are building step S10 of the JobSeeker→Hermes migration: a thin pre-run SCRIPT that
Hermes cron executes BEFORE waking the agent. It does only the deterministic pre-work; all
LLM judgment lives in the agent session. This replaces most of scripts/job-run.sh (per
decision D2) — do NOT port the bash retry/timeout/status/notify logic; Hermes cron provides
that natively (inactivity budget, failure_streak alerts, execution ledger).

CONTEXT (self-contained):
- Repo: /Users/alkzoupas/code/jobseeker. The script lives at $HERMES_HOME/scripts/
  jobseeker-prerun.sh (Hermes cron requires scripts to resolve inside $HERMES_HOME/scripts/).
  It must `cd /Users/alkzoupas/code/jobseeker` first.
- Do, in order:
  1. FULL WAKE before touching Chrome: `caffeinate -u -t <TIMEOUT+300> &` with an EXIT trap
     to kill it (a Mac in DarkWake silently drops the Chrome launch — this is load-bearing,
     keep it). TIMEOUT default 2700s.
  2. Browser probe: `node scripts/browser-probe.mjs` (writes data/.browser-status.json).
     If the resulting read_mechanism is "none", wait 45s and retry ONCE (cold Chrome at
     08:00). Never fatal — "no browser" is a reportable outcome.
  3. Board pre-drain (only if pages are readable): `node scripts/board-sweep.mjs --max 15`
     under a 900s cap, so the scout reads cached text instead of being told to open Chrome.
  4. Optional monthly spend gate: read `node server/record.mjs list-spend` month_total_usd
     vs the config ceiling (config/job-seeker.config.md max_spend_per_month_usd); if over,
     write a skipped status + osascript notify + `record.mjs log run-skipped …` and still
     wake the agent to REPORT it (never silent).
- FINAL LINE: print a JSON gate `{"wakeAgent": true, "context": {…probe summary…}}`.
  (Hermes cron reads a trailing {"wakeAgent": …} line; default true. We ALWAYS wake so the
  agent can report a broken browser — but include the probe summary in context.)

BUILD (TDD):
1. Failing test: scripts/migration/test-prerun.sh — run the script in a sandboxed env
  (point it at a scratch data/ via a copy, or assert on the .browser-status.json it writes);
  assert it (a) writes data/.browser-status.json, (b) drains the board queue when readable,
  (c) exits with a parseable trailing wakeAgent JSON line, (d) the spend gate blocks +
  notifies when the ceiling is hit.
2. RED, then implement $HERMES_HOME/scripts/jobseeker-prerun.sh (chmod +x).
3. GREEN; real data/ only receives the probe/board-sweep writes (which are the intended
  pre-work) — confirm no proposal/application rows were created by the script itself.

ACCEPTANCE: test green; script is executable and resolves inside $HERMES_HOME/scripts/;
it performs pre-work only (no LLM, no proposals). Commit the test + a pointer doc.
```

---

## Prompt 11 — S11: Cron job (created PAUSED)

```text
You are building step S11 of the JobSeeker→Hermes migration: the single Hermes CRON JOB
that replaces launchd. It is created PAUSED (a safe canary) — not yet scheduled.

CONTEXT (self-contained):
- The job runs the full daily pipeline: pre-run script → agent session (orchestrator prompt
  + six skills) → digest delivered to chat. All pieces exist from S1–S10:
    workdir  = /Users/alkzoupas/code/jobseeker   (absolute; injects the repo CLAUDE.md and
                                                       makes file/terminal tools operate in-repo)
    skills   = [jobseeker-inbox-tracker, jobseeker-chat-tracker, jobseeker-prioritizer,
                jobseeker-role-scout, jobseeker-reconciler, jobseeker-supervisor]  (in order)
    script   = jobseeker-prerun.sh               (resolves in $HERMES_HOME/scripts/)
    prompt   = the text of docs/migration/orchestrator-prompt.md
    deliver  = origin                              (this chat)
    schedule = "0 8 * * *"                         (daily 08:00, matches the old launchd)
    name     = jobseeker-daily-run
- MODEL PIN (decision D1): the cron job MUST be pinned to an explicit provider+model,
  because Hermes cron FAILS CLOSED on unpinned jobs if the global default drifts to a paid
  provider. Alkis will name the exact model/provider at execution time — use whatever he
  specifies (do not guess). The pin is user-owned: set it via the CLI
  `hermes cron edit <job_id> --provider <p> --model <m>` (the agent's cronjob tool cannot
  set per-job models). If Alkis has not yet named one, create the job and STOP to ask.
- Create it PAUSED so it cannot fire before the canary: `hermes cron create … --paused
  --paused-reason "Awaiting canary (S12)"`.

BUILD (TDD):
1. Failing check: scripts/migration/test-cronjob.sh — assert, via `hermes cron list` /
   `hermes cron doctor`, that a job named jobseeker-daily-run exists with: state paused,
   workdir set to the repo (exists), all six skills attached and ready, script present in
   $HERMES_HOME/scripts/, deliver origin, schedule "0 8 * * *", and a model/provider pin.
2. RED (job absent), then create it with the exact knobs above (CLI or cronjob tool; use
   --paused). Apply the model pin via `hermes cron edit`.
3. GREEN: `hermes cron doctor` reports the job healthy (config validates, skills ready,
   workdir exists); `hermes cron list` shows it paused with the right knobs.

ACCEPTANCE: doctor healthy; job paused with all six skills + script + workdir + deliver
origin + model pin. Do NOT resume it (that is S13). Record the job id in
docs/migration/cron-job-id.txt. Commit that file.
```

---

## Prompt 12 — S12: Canary run (manual fire, supervised)

```text
You are executing step S12 of the JobSeeker→Hermes migration: the CANARY — fire the paused
cron job ONCE, manually, and verify end-to-end. This is a verification gate, not a build
step (no new code). Alkis is present and will judge the output with you.

CONTEXT (self-contained):
- The job `jobseeker-daily-run` exists, paused, fully wired (S11). Its id is in
  docs/migration/cron-job-id.txt. Firing it manually does NOT consume the scheduled
  occurrence and does not resume the schedule.
- Baseline (per Alkis): there is NO formal reference diff — this first supervised Hermes
  run IS its own baseline. We eyeball it together for correctness and honesty, not a byte
  diff against a captured Claude run.

EXECUTE + VERIFY (in order; stop and report on the first failure):
1. `hermes cron run <job_id>` (triggers on the next scheduler tick).
2. Confirm the pre-run script ran: data/.browser-status.json is fresh; board queue drained.
3. Confirm the digest LANDED IN THIS CHAT (the cron delivery) and is well-formed: fixed
   section headers, ≤5 New Job Postings each with a URL on its own line, no emojis,
   Coverage/System present only when warranted.
4. Confirm data/.last-digest.md was written with a correct `delivered:` line (written
   BEFORE delivery).
5. Confirm the DASHBOARD reflects it: `node server/dashboard.mjs` (port 4319) shows the new
   digest + proposals.
6. Confirm the Hermes execution ledger shows the attempt `completed` (`hermes cron runs
   <job_id> --limit 3`) and there is NO double-logging (single run boundary in activity.md).
7. Review the proposals against data/ for plausibility (real companies, verbatim URLs that
   resolve); flag anything that looks fabricated or dead.

ACCEPTANCE: all six checks pass and Alkis is satisfied the digest is honest and useful.
If any check fails, STOP, capture the exact error/output, and report — do not proceed to
cutover. Leave the job PAUSED until Alkis says it's good.
```

---

## Prompt 13 — S13: Cutover (final)

```text
You are executing step S13 of the JobSeeker→Hermes migration: CUTOVER — make Hermes cron
the single daily trigger and retire the old launchd path. The canary (S12) is green and
Alkis has approved it.

CONTEXT (self-contained):
- Old trigger: a launchd LaunchAgent for the daily run. NOTE: on this machine only
  `com.jobseeker.browser` (the Chrome Automation bridge) is currently loaded — the daily
  `com.jobseeker.jobrun` may already be absent. Verify, don't assume:
    launchctl list | grep -i jobseeker
  KEEP `com.jobseeker.browser` (the browser bridge the pipeline depends on). Retire ONLY a
  daily-run agent if one exists: `launchctl unload ~/Library/LaunchAgents/com.jobseeker.jobrun.plist`.
- The Hermes job `jobseeker-daily-run` is paused and canary-green.

EXECUTE (in order):
1. GIT HYGIENE FIRST: the repo working tree is dirty (uncommitted changes to
   .claude/AGENT-RULES.md and .claude/agents/role-scout.md; deleted signal-scout.md /
   signals.md). Do NOT commit migration artifacts on top of Alkis's in-flight edits. Show
   him `git status`, let him decide what to commit/stash, and only then commit the
   migration artifacts (docs/migration/, scripts/migration/ tests) as a clean, separate
   commit.
2. Retire the old daily LaunchAgent if present (keep .browser). Confirm with `launchctl list`.
3. RESUME the Hermes job: `hermes cron resume <job_id>` (schedules the next 08:00 fire).
4. Run ONE supervised unattended morning (or a manual `hermes cron run` standing in for it):
   confirm digest + dashboard + single-logging, exactly as the canary checks.
5. Confirm `hermes cron doctor` is healthy and the old path will not double-fire.
6. Optionally archive the now-redundant .claude/ agent/command files (move to
   .claude/_archive/) ONLY after Alkis confirms the Hermes path is stable — leave them in
   place otherwise (harmless).

ACCEPTANCE: exactly ONE daily trigger exists (Hermes cron); the browser LaunchAgent is
intact; a full run produces digest + dashboard with no double-logging; git tree is clean
and migration artifacts are committed separately. Report the final state of both schedulers.
```

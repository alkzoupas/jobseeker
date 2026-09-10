# JobSeeker → Hermes Migration — Build Blueprint (Phase 3)

**Status:** Draft v1, post re-break + sizing review. Awaiting Alkis approval → then Phase 4 (one TDD prompt per step).
**Depends on:** `SPEC.md` (approved 2026-09-08, D1+D2 accepted).
**Repo:** `/Users/alkzoupas/code/jobseeker`. **Body stays; brain migrates.**

## Sizing rules applied (the re-break pass)
- Each step = **one testable unit / one commit**. Small enough to verify safely, big
  enough to move forward. No step is a big-bang jump.
- Every step **builds on the previous** and ends in a wired, tested state — no orphans.
- The one genuinely-large playbook (`role-scout`, 27k chars) is **split into two steps**
  (stateless sources, then browser pass) so no single prompt is a monster.
- The test harness (S1) comes **first** because every skill step depends on it.
- `record.mjs` hardcodes its data dir → the harness uses a **scratch copy** of
  `server/`+`data/`; skill dry-runs write to scratch, never your real data.

## Verified facts the blueprint rests on (measured 2026-09-08, not assumed)
| Fact | Evidence |
|---|---|
| `gog` reads Calendar from this context | returned the real Stripe interview (Sep 9) |
| `gog` has a top-level `-n/--dry-run` (no mutations) | `gog gmail --help` |
| `browser-do.mjs` drives Chrome from Hermes via the LaunchAgent | probe: `chrome=running · read-pages=apple-events · tabs=29` |
| `record.mjs` data dir is hardcoded to `server/../data` (no env override) | source line 53–55 |
| `com.jobseeker.browser` LaunchAgent is loaded; `.jobrun` is **not** | `launchctl list` |
| Hermes cron: inactivity budget (not wall-clock) for LLM jobs; `workdir` injects CLAUDE.md; skills attach in order; `deliver:origin`; create-paused canary | cron docs + background-systems ref |

---

## The steps (ordered)

### S1 — Test harness: scratch data + parity runner
- **Build:** a `scripts/migration/harness.mjs` (or shell) that:
  - snapshots the repo `data/` tree into a scratch dir (e.g. `/tmp/jobseeker-scratch/data`) **and** copies `server/` next to it (so `record.mjs`'s hardcoded `../data` resolves into scratch);
  - exposes a helper to run any skill's dry-run against that scratch copy;
  - captures the resulting `record.mjs` writes (proposals/, applications/, communications.md, tasks.md rows) for diffing.
- **Test:** run the harness against a known `data/` snapshot; assert it (a) creates an isolated scratch tree, (b) a `record.mjs` write lands in **scratch** not the real repo `data/`, (c) re-running is idempotent.
- **Depends on:** nothing. **Commits:** `scripts/migration/harness.*`.

### S2 — Skill: `jobseeker-inbox-tracker` (Gmail + Calendar via `gog`)
- **Build:** a Hermes skill translating `.claude/agents/inbox-tracker.md` to use the
  **`gog` CLI** instead of Claude's Gmail MCP connector: `gog gmail search "<query>" -n`
  (read-only) for email, `gog calendar list` for interviews; same tracking logic
  (interviews, referrals, stage advances) and same `record.mjs` writes.
- **Test (parity):** run the skill in dry-run against the S1 scratch snapshot; diff its
  `record.mjs` writes against a **reference** (a captured Claude run's output, or the
  current `data/` rows). Same inputs → same tracked rows. No mutation of real data.
- **Depends on:** S1.

### S3 — Skill: `jobseeker-chat-tracker` (WhatsApp Web + LinkedIn via browser)
- **Build:** a Hermes skill translating `.claude/agents/chat-tracker.md` to drive
  **`node scripts/browser-do.mjs chat-sweep [--linkedin]`** (the LaunchAgent bridge);
  same unread/reply detection and `record.mjs` writes. Honors the "name the capability,
  never just the app" digest rule.
- **Test:** dry-run against scratch; assert it reads `.browser-status.json`, skips cleanly
  when `read_page_content:false` (and emits the verbatim `blockers[]`), and writes the
  expected communication rows when a browser is present.
- **Depends on:** S1.

### S4 — Skill: `jobseeker-prioritizer` (per-market)
- **Build:** a Hermes skill from `.claude/agents/prioritization-agent.md`: given one
  market, web-research and rank it; writes the prioritized set via `record.mjs`.
- **Test:** dry-run for one market against scratch; assert it reads `audit.mjs` staleness
  and writes the expected priority rows.
- **Depends on:** S1.

### S5 — Skill: `jobseeker-role-scout` (part 1 — stateless sources)
- **Build:** the non-Chrome half of `.claude/agents/role-scout.md`: HN "Who is hiring?",
  the **a16z Jobs Gmail digest via `gog`**, and the board-registry-driven vendor
  careers-site sweep (stateless, parallel). Reads `record.mjs list-keys` for the dedupe
  set and `list-boards` for ATS endpoints. Writes new proposals via `record.mjs`.
- **Test:** dry-run against scratch; assert it (a) does not re-propose any `skip:true`
  key, (b) writes proposals with **verbatim** `job_url`, (c) reports uncovered boards.
- **Depends on:** S1, S4 (scout runs after prioritizer in the chain).

### S6 — Skill: `jobseeker-role-scout` (part 2 — browser pass)
- **Build:** the Chrome half of role-scout: LinkedIn, DreamWorkHQ, Wellfound, Otta in a
  **single serialized** browser slot (via `browser-do.mjs`), covering all markets at once.
  This is the only Chrome-driving work and must never run concurrently with S3.
- **Test:** dry-run against scratch with a browser present; assert it runs the serialized
  pass, caches/reads board text, and writes proposals. Assert it is a no-op (with a
  Coverage note) when `.browser-status.json` says pages are unreadable.
- **Depends on:** S5, S3 (serialization contract).

### S7 — Skill: `jobseeker-reconciler`
- **Build:** a Hermes skill from `.claude/agents/reconciler.md`: reads all open tasks +
  `data/communications.md` and conservatively closes those proven done by cross-channel
  evidence. Runs in its own context (large read), alongside curation.
- **Test:** dry-run against scratch with a seeded "already done" task; assert it closes
  exactly the provable ones and leaves ambiguous ones open.
- **Depends on:** S1, S2/S3 (needs tracker output to reconcile against).

### S8 — Skill: `jobseeker-supervisor` (barrier)
- **Build:** a Hermes skill from `.claude/agents/supervisor.md`: the duplicate/overlap/
  attention audit, run **last** so its counts reflect reconciler closures + scout writes.
  Also reads the Hermes execution ledger (replaces `data/.job-run.status.json`) to report
  a prior failed run at the top of the digest.
- **Test:** dry-run against scratch; assert it flags a seeded duplicate and reports the
  prior-run state.
- **Depends on:** S2–S7 (it's the barrier).

### S9 — Orchestrator prompt (the `/job-run` equivalent)
- **Build:** the cron job's **prompt** text, porting `.claude/commands/job-run.md`:
  the concurrency model (≤3 in flight, Chrome serial), the stage ordering
  (track → per-market prioritizer→scout chains + reconciler alongside → supervisor
  barrier), the **fixed digest format**, and delivery (write `.last-digest.md` first,
  then the final response is delivered to chat). Layered on top of the S2–S8 skills.
- **Test:** a dry orchestration run against scratch (all skills attached) that produces a
  correctly-formatted digest with the right Coverage/System sections; assert the digest
  file is written before delivery.
- **Depends on:** S2–S8.

### S10 — Pre-run `script` (the thin hardening wrapper)
- **Build:** a `$HERMES_HOME/scripts/jobseeker-prerun.sh` that does only the
  deterministic pre-work: `caffeinate -u` full wake → `browser-probe.mjs` (+1 retry
  after 45s if no mechanism) → `board-sweep.mjs --max 15` (900s cap) → optional monthly
  spend gate (`record.mjs list-spend`). Emits `{"wakeAgent": …}` so a hard-failed probe
  can still wake the agent to *report* it (never silent). Replaces ~250 lines of
  `job-run.sh` bash with this + Hermes-native machinery (D2).
- **Test:** run it; assert it writes `.browser-status.json`, drains the board queue, and
  exits with a parseable `wakeAgent` line. Assert the spend gate blocks (with status +
  notify) when the monthly ceiling is hit.
- **Depends on:** S1 (uses the same body scripts).

### S11 — Cron job (created **paused**)
- **Build:** one Hermes cron job, `0 8 * * *`, with: `workdir=/Users/alkzoupas/code/jobseeker`
  (injects CLAUDE.md), `skills=[S2,S3,S4,S5,S6,S7,S8]` in order, `script=S10`,
  `deliver=origin`, **pinned model/provider (D1 — Alkis names it)**, and the S9 prompt.
  Created **paused** (safe canary) — not yet scheduled.
- **Test:** `hermes cron doctor` reports it healthy (config validates, skills ready,
  workdir exists); `hermes cron list` shows it paused with the right knobs.
- **Depends on:** S9, S10 + D1 model pin.

### S12 — Canary run (manual fire, supervised)
- **Build:** none — this is the verification gate. Fire S11 once with `hermes cron run`.
- **Test (the real parity gate):** assert, in order — digest lands **in this chat**;
  `data/.last-digest.md` written with a correct delivery line; the **dashboard** (:4319)
  reflects it; the Hermes execution ledger shows `completed`; no double-logging.
  **Baseline (per Alkis, 2026-09-08):** there is no formal reference diff — the first
  supervised Hermes run *is* its own baseline. We eyeball it together: is the digest
  well-formed, are the proposals plausible against `data/`, does Coverage/System read
  honestly? Alkis judges fit; we do not diff against a captured Claude run.
- **Depends on:** S11.

### S13 — Cutover (final)
- **Build:** confirm `com.jobseeker.jobrun` state and retire it if present (keep
  `.browser`); **resume** the S11 cron job on `0 8 * * *`; run one supervised morning.
- **Test:** a full unattended morning where Hermes cron is the *only* trigger — digest +
  dashboard + single-logging all correct. Then optionally archive the old `.claude/` files.
  (Resolve the dirty git tree first — don't commit migration artifacts over in-flight edits.)
- **Depends on:** S12 green.

---

## Dependency graph (for the Phase 4 prompt ordering)
```
S1 ─┬─ S2 ─┐
    ├─ S3 ─┤        ┌─ S7 (reconciler)
    ├─ S4 ─┴─ S5 ─ S6 (scout browser)
    │                 │
    └─ S8 (supervisor, barrier: needs S2–S7)
                 │
        S9 (orchestrator prompt) ─ S10 (pre-run script) ─ S11 (cron, paused)
                 │                                                        │
                 └────────────────────── S12 (canary) ◄─────────────────┘
                                              │
                                          S13 (cutover)
```

## Explicitly deferred (not in this blueprint — see SPEC §7)
On-demand `/apply`,`/followup`,`/tailor`,… · WhatsApp phone delivery · dashboard Setup
wizard · any change to the Node body or its tests.

# JobSeeker → Hermes Migration — Developer-Ready Spec

**Status:** Phase 2 draft, awaiting Alkis approval.
**Author:** Zabagabee (Hermes). **Date:** 2026-09-08.
**Repo:** `/Users/alkzoupas/code/jobseeker` (git, zero npm runtime deps).

---

## 0. The one-sentence plan

**Keep the body, transplant the brain.** The Node/Markdown state layer
(`server/record.mjs`, `audit.mjs`, the Apple-Events browser scripts, the
dashboard on :4319, `data/*.md`) is language-agnostic and battle-tested — every
test in it guards a real historical bug. It stays untouched and is called from
Hermes via `node`. What migrates is the *brain*: the 10 agent playbooks +
`/job-run` orchestrator become Hermes **skills**, and the launchd 08:00 trigger
becomes a **Hermes cron job**.

---

## 1. Requirements

### Functional
- F1. A daily unattended run performs the full `/job-run` pipeline: **track →
  prioritize/curate → reconcile → supervise → digest**, with the same fixed
  digest format and the same approval-queueing (never applies or sends on its own).
- F2. **Track** reads all four channels: Gmail + Calendar, WhatsApp Web + LinkedIn.
- F3. **Curate** refreshes stale markets (per `audit.mjs`), runs the vendor
  careers-site sweep, the LinkedIn/DreamWorkHQ/Wellfound/Otta browser pass, and
  the stateless HN + a16z-Jobs-Gmail sources; writes new proposals via `record.mjs`.
- F4. **Reconcile** closes tasks proven done by cross-channel evidence (own context).
- F5. **Supervise** runs the duplicate/overlap/attention audit last (barrier).
- F6. **Digest** is written to `data/.last-digest.md` first (durable, dashboard
  reads it), then delivered to **this Hermes chat**. WhatsApp push is a later phase.
- F7. The run reports partial coverage, browser faults, and prior-run failure in
  the digest exactly as today (the "a fault you can't see is a fault that doesn't
  get fixed" rules).

### Non-functional
- N1. **Idempotent** — re-running never double-writes (the `record.mjs` lock +
  dedupe already guarantee this; we rely on it, not re-implement it).
- N2. **Bounded** — a wedged run cannot hold the `data/` lock or burn budget
  indefinitely (Hermes inactivity budget + a pre-run timeout backstop).
- N3. **Memory-safe** — no fan-out may approach the 2026-07-29 jetsam condition
  (3-subagent cap preserved; see §4).
- N4. **Visible** — a failed or partial run is surfaced in the next digest and via
  Hermes failure/incident machinery; never silent.
- N5. **Single source of truth for the schedule** — exactly one daily trigger; no
  double-logging (launchd retired at cutover).

---

## 2. Architecture choices

### 2.1 The body (stays, called via `node`)
| Component | Role | Invoked as |
|---|---|---|
| `server/record.mjs` | locked atomic writer + queries (`list-keys`, `list-boards`, `list-proposals`, `log`, `add-spend`) | `node server/record.mjs …` |
| `server/audit.mjs` | market staleness, browser_debt, last_scheduled_run | `node server/audit.mjs <date>` |
| `scripts/browser-do.mjs` | routes Chrome work through the **`com.jobseeker.browser` LaunchAgent** (stable, permanently-granted Apple-Events identity) | `node scripts/browser-do.mjs chat-sweep / read-url / board-sweep` |
| `scripts/browser-probe.mjs` | measures browser capability → `data/.browser-status.json` | pre-run script |
| `scripts/board-sweep.mjs` | drains the browser board queue (cached page text) | pre-run script |
| `scripts/check-urls.mjs` | re-validates stored proposal links | in-run |
| `server/dashboard.mjs` (:4319) | reads `data/` tree + `.last-digest.md` | unchanged, zero porting |

**Why `browser-do.mjs` is the linchpin:** it makes the Apple Events come from a
fixed LaunchAgent identity, *not* whichever agent binary is running. That means
the macOS Automation grant (already approved for `com.jobseeker.browser`) works
for Hermes exactly as it does for Claude — **no re-prompt, no QR-code profile.**
This is the single biggest de-risking fact in the whole migration.

### 2.2 The brain (migrates to Hermes)
The 10 `.claude/agents/*` playbooks + `/job-run` become **Hermes skills**:

| Claude agent | Hermes skill (proposed) | Channel / tool |
|---|---|---|
| `jobseeker.md` (front door) | — folded into the orchestrator prompt | — |
| `inbox-tracker.md` | `jobseeker-inbox-tracker` | **`gog` CLI** (Gmail + Calendar) — replaces Claude's Gmail MCP connector |
| `chat-tracker.md` | `jobseeker-chat-tracker` | **`node scripts/browser-do.mjs chat-sweep`** (WhatsApp Web + LinkedIn) |
| `prioritization-agent.md` | `jobseeker-prioritizer` | web research, per market |
| `role-scout.md` | `jobseeker-role-scout` | web + browser pass + HN + a16z-Gmail (via `gog`) + Dreamwork/a16z |
| `reconciler.md` | `jobseeker-reconciler` | reads tasks + communications (own context) |
| `supervisor.md` | `jobseeker-supervisor` | audit (barrier) |
| `application-agent`, `comms-agent`, `reviewer-agent` | **out of scope** (on-demand `/apply`,`/followup`,`/tailor`) | — |

The **`/job-run` command** becomes the cron job's **prompt**, layered on top of
the attached skills. The concurrency model (max 3 in flight, Chrome serial) is
preserved via Hermes `delegate_task` (`delegation.max_concurrent_children`,
default 3) — the same cap that AGENT-RULES §13 enforces.

### 2.3 The trigger (Hermes cron replaces launchd)
One Hermes **cron job**, `0 8 * * *`, with:
- `workdir = /Users/alkzoupas/code/jobseeker` → injects the repo's `CLAUDE.md`
  (working-style rules) and makes all file/terminal tools operate in-repo.
- `skills = [jobseeker-inbox-tracker, jobseeker-chat-tracker, …]` (loaded in order).
- `script = <pre-run>` → the deterministic pre-work (see §2.4).
- `deliver = origin` → this chat. Plus the agent writes `.last-digest.md`.
- **Pinned model/provider** (see §6, decision D1).

### 2.4 Pre-run `script` vs. agent — the hardening split (decision D2)
Today `scripts/job-run.sh` does a lot of bash hardening *around* the `claude -p
/job-run` call. Much of it is now provided **natively by Hermes cron**, so we
split the work:

| Concern | Today (job-run.sh) | After migration |
|---|---|---|
| Full wake before Chrome (`caffeinate -u`) | bash | **kept** in pre-run `script` (Hermes has no equivalent; DarkWake silently drops the Chrome launch) |
| Browser probe + 1 retry after 45s | bash | **kept** in pre-run `script` (writes `.browser-status.json`) |
| Board-sweep pre-drain (max 15, 900s cap) | bash | **kept** in pre-run `script` (deterministic, $0) |
| 45-min hard timeout | bash watchdog | **Hermes inactivity budget** (a *constantly-working* 45-min run never trips it — confirmed in docs) + a `script_timeout_seconds` backstop |
| Retry once on transient failure | bash loop | **Hermes** `failure_streak` + incident machinery (we do NOT hand-roll a retry loop) |
| Spend cap `$5`/run + monthly ceiling | bash + `--max-budget-usd` | **Hermes** provider/model pin + (optional) a pre-run spend gate reading `record.mjs list-spend` |
| RSS guard (kill >4GB, abort >12GB) | `rss-guard.sh` | **dropped** — Hermes `delegate_task` children are process-local and bounded by the 3-cap; revisit only if a leak recurs |
| `data/.job-run.status.json` + macOS notify on failure | bash | **Hermes** execution ledger (`hermes cron runs`) + delivery-failure status; the *digest* still reports prior-run failure (that logic moves into the supervisor skill) |
| Reap stale WhatsApp MCP stdio instances | bash | **dropped** — no WhatsApp MCP in the Hermes path (delivery is via chat, not a stdio bridge) |

**Net:** `job-run.sh` shrinks to a thin pre-run script (caffeinate + probe +
board-sweep) that Hermes cron runs *before* waking the agent. The LLM judgment
work (track→curate→reconcile→supervise→digest) lives in the agent session. The
old `com.jobseeker.jobrun` LaunchAgent is retired at cutover; **only**
`com.jobseeker.browser` (the Chrome bridge) stays.

> ⚠️ Note: `com.jobseeker.jobrun` is **not currently loaded** on this machine
> (only `com.jobseeker.browser` is). Cutover will confirm the exact state and
> retire whatever exists — there may be nothing to remove.

---

## 3. Data handling
- **Source of truth stays `data/*.md`** (proposals/, applications/, markets/,
  communications.md, tasks.md, boards.md, spend.md, activity.md). No schema
  change. Hermes reads/writes through `record.mjs` exactly as Claude did, so the
  dashboard and any future tooling see identical data.
- **Flow:** pre-run script (probe → board-sweep) writes `.browser-status.json` +
  cached board text → agent session: inbox-tracker (`gog`) & chat-tracker
  (`browser-do`) in parallel → per-market prioritizer→scout chains (≤3 concurrent,
  Chrome serial) + reconciler alongside → supervisor (barrier) → digest written to
  `.last-digest.md` then delivered to chat.
- **New files the migration adds:** `data/.last-digest.md` (already exists, reused),
  Hermes skills under `~/.hermes/skills/`, one cron job in `~/.hermes/cron/jobs.json`.
  Nothing new inside the repo's `data/` schema.

---

## 4. Error-handling strategy
- **Browser unavailable** (`.browser-status.json` `read_page_content:false`) →
  chat-tracker skipped; its `blockers[]` copied verbatim into the digest's
  Coverage + System sections (existing rule, preserved in the skill).
- **A channel not set up** → note it, continue (never fatal).
- **Run dies mid-write** → `record.mjs` lock self-heals after 60s; Hermes marks
  the attempt `unknown` in its ledger and alerts.
- **Delivery fails** → Hermes records `delivery_failed` (distinct from run
  failure); the durable `.last-digest.md` + dashboard still have it.
- **Prior run failed** → supervisor reads the Hermes ledger / status and says so
  at the top of today's digest.
- **Spend** → pinned model + optional pre-run monthly-ceiling gate (reads
  `record.mjs list-spend`); a blocked run writes its own status + notifies, never
  silent.

---

## 5. Testing plan (per layer)
- **Body:** unchanged — the existing Node test suites still pass untouched (they
  guard real bugs; we do not regress them). We run the full suite before/after to
  prove zero body regression.
- **Skills:** each skill gets a **dry-run** — run it against the live `data/` in
  read-mostly mode and diff the resulting `record.mjs` writes against a known-good
  Claude run's output (same inputs → same proposals/rows). This is the parity gate.
- **Pre-run script:** unit-check that it writes `.browser-status.json`, drains the
  board queue, and exits non-zero (→ Hermes error alert) if the probe hard-fails.
- **Cron job:** create it **paused** (safe canary), fire it once manually
  (`hermes cron run`), verify: digest lands in chat, `.last-digest.md` written,
  dashboard reflects it, ledger shows `completed`. Then resume the schedule.
- **End-to-end cutover:** one full morning where Hermes cron is the *only*
  trigger; confirm digest + dashboard + no double-logging.

---

## 6. Open decisions — my recommendation, confirm or veto

**D1 — Model/provider for the unattended run.** The interactive chat runs on
`qwen3.8-27b-mlx`. A daily job doing heavy research + judgment should be **pinned**
to a capable model (Hermes cron fails *closed* on unpinned jobs if the global
default drifts to a paid provider). **Recommendation:** pin the cron job to the
same model you trust for this work; tell me which and I'll set it. (This is a
config pin, not architecture — but it must be decided before the canary run.)

**D2 — Hardening split (§2.4).** Keep only caffeinate + probe + board-sweep in a
thin pre-run `script`; let Hermes-native machinery (inactivity budget, failure
streak, incidents, ledger) replace the bash retry/timeout/status/notify logic;
drop `rss-guard.sh` and the WhatsApp-MCP reaper. **Recommendation: yes** — it
removes ~250 lines of bash we'd otherwise maintain and leans on machinery that's
already tested. Veto if you want the bash wrapper kept verbatim for familiarity.

---

## 7. Explicitly OUT of scope (this phase)
- On-demand commands: `/apply`, `/followup`, `/tailor`, `/curate`, `/track`,
  `/markets`, `/onboard`, `/parse-cv`, `/send-approval` (and their agents).
- WhatsApp/baileys phone delivery (revisit after the chat path is proven).
- The dashboard Setup wizard.
- Any change to the Node body or its tests.

## 8. Cutover (final step, after canary is green)
1. Confirm `com.jobseeker.jobrun` state; retire it if present (keep `.browser`).
2. Resume the Hermes cron job on `0 8 * * *`.
3. One supervised morning; verify digest + dashboard + single-logging.
4. Leave the old `.claude/` files in place (harmless) until you're confident, then
   optionally archive them.

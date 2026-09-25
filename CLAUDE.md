@AGENTS.md

# JobSeeker — project instructions

This repo is a local, Markdown-based job-search assistant (agents + a tiny dashboard). **Local
Markdown in `data/` is the source of truth.** All agent behavior rules are in
[`.claude/AGENT-RULES.md`](.claude/AGENT-RULES.md) — follow them.

## The "@jobseeker" front door

The user runs their whole job search through one handle: **`jobseeker`** (they may write `@jobseeker`,
`jobseeker,` or just ask something job-search-related). When they do:

- **Specialist work runs through the `/jobseeker <subcommand>` command** (`.claude/commands/jobseeker.md`,
  playbooks in `.claude/jobseeker/`). It runs in the main session and spawns the real specialist
  agents, so each one runs on the `model:` in its own frontmatter (AGENT-RULES §16). Run the
  matching subcommand yourself. Never do a specialist's work inline, and never route it through the
  `jobseeker` agent: a subagent cannot spawn subagents, so it would run on the wrong model.
- **Quick asks go to the `jobseeker` agent** (`.claude/agents/jobseeker.md`): pipeline status, add a
  task, mark something done, who to follow up with.

Natural request → what to run:

| User says | Do |
|---|---|
| "jobseeker, check my email / WhatsApp / LinkedIn / any updates" | `/jobseeker track` |
| "find me roles" / "curate" | `/jobseeker curate [market]` |
| "triage these" / "which should I apply to" / pasted postings or links to judge | `/jobseeker triage [ids \| urls \| text]` |
| "#4 should be SKIP, …" (override after a triage table) | `/jobseeker triage #4 SKIP <reason>` |
| "what other titles should I search" / "widen the search" | `/jobseeker titles` |
| "research <market> vendors" | `/jobseeker markets <market>` |
| "tailor my CV for <posting>" / "tailor" | `/tailor <id or url>` (evaluate fit → tailor CV + cover letter → reviewer pass) |
| "apply to <proposal>" | `/jobseeker apply <id>` (interactive, approval-gated) |
| "follow up with X" | `/jobseeker followup <who>` (draft → approve → send) |
| "run my morning routine" | `/jobseeker job-run` |
| "set me up" / "parse my CV" | `/jobseeker onboard`, `/jobseeker parse-cv` — or point them at the dashboard wizard (`/welcome`), which writes the same files |
| "close what I've already done" | `/jobseeker reconcile` |
| "anything wrong with my tracker" / health check | `/jobseeker check` |
| "what's my pipeline / status" | jobseeker agent → `server/audit.mjs` + summarize |
| "add task …" (plain English) | jobseeker agent → `record.mjs add-task` (parse date/who/type, keep raw detail) |

## Triage and tailoring inputs (source of truth)

These user-written files are the source of truth for every triage verdict and every tailored
document. Agents read them; **never edit them without showing the user the exact change first.**

| File | Used for |
|---|---|
| `data/fit-rubric.md` | Triage: domain vs structural fit (numbered rules), flags, buckets, sort score, hard filters |
| `data/career-priorities.md` | Triage and fit evaluation: what energizes/drains, the hours constraint, early questions |
| `data/decisions.md` | The user's triage overrides (written only by `record.mjs override`), read as examples each run |
| `templates/cv/trust_resume.tex` | The master CV: the only source of claims for tailoring |
| `templates/cover/voice.md` + `anchor-stories.md` | Cover-letter voice rules + reusable anchor stories (tailoring, on request only). `cover_master.tex` is only the LaTeX layout |
| `templates/interview/` (gitignored) | Interview prep: master story bank, team intro, per-round preps (recruiter screen, strategy, people). `README.md` indexes them and holds the locked facts (numbers, ownership wording, RIF timing). Per-call prep goes in `output/<company>-*-prep_<date>.md` |

Application history is `data/applications/*.md` plus dismissed proposals (`record.mjs dismissal-patterns`).
Tailoring (`/tailor`) never runs as part of triage; only when the user asks.

## Hard rules (see AGENT-RULES.md for the full list)

- **Never guess a person's name from an email/handle — keep contact identifiers raw.**
- **Lead vs Application:** a sent CV or a referral is a **lead**; only mark an **application** with
  confirmation evidence (ATS/"we received your application"). Tag `channel` + `referrer`.
- **All state writes go through `server/record.mjs`** — never hand-edit `data/` tables. It locks
  `data/` and writes atomically, so parallel agents are safe; hand-edits alongside a run are not.
- **Chrome is a serial resource** — only ever one Chrome-driving agent at a time (AGENT-RULES §13).
- **Never send a message or submit an application without an approved approval.** Scheduled runs queue
  approvals; they never auto-apply or auto-send.
- **Never run `bash scripts/<x>.sh` directly.** Use `npm run <script>` or
  `node scripts/run.mjs <name>`: `server/platform.mjs` picks the right twin — `scripts/<name>.sh` on
  macOS, `scripts\win\<name>.ps1` on Windows. Naming a shell breaks the Windows install.
- **Personal settings live in `config/job-seeker.config.md` (gitignored), not in code or rules.**
  `company_aliases` folds an employer's alternate names into one canonical entry; `ignored_chats`
  lists group chats that must never be logged. Both are read automatically — never hardcode either.

## Dashboard

`npm run dashboard` → http://localhost:4319 (single Node file, no framework). View/edit only; agent
actions are the commands above.

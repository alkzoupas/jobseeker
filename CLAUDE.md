@AGENTS.md

# JobSeeker — project instructions

A local, Markdown-based job-search assistant (agents + a tiny dashboard). **Local Markdown in `data/`
is the source of truth.** Agent behavior rules, including the user-written input files that must never
be edited silently (§18), are in [`.claude/AGENT-RULES.md`](.claude/AGENT-RULES.md). Follow them.

## The "@jobseeker" front door

When the user says `jobseeker` / `@jobseeker` or asks something job-search-related:

- **Specialist work → run `/jobseeker <subcommand>` yourself** (`.claude/commands/jobseeker.md`,
  playbooks in `.claude/jobseeker/`). It spawns the specialists so each runs on its own `model:`
  (AGENT-RULES §16). Never do a specialist's work inline or route it through the `jobseeker` agent:
  a subagent can't spawn subagents.
- **Quick asks → the `jobseeker` agent**: pipeline status (`server/audit.mjs`), add a task
  (`record.mjs add-task`), mark done, who to follow up with.

| User says | Run |
|---|---|
| check email / WhatsApp / LinkedIn / updates | `/jobseeker track` |
| find me roles / curate | `/jobseeker curate [market]` |
| triage these / which should I apply to / pasted postings | `/jobseeker triage [ids \| urls \| text]` |
| "#4 should be SKIP, …" after a triage table | `/jobseeker triage #4 SKIP <reason>` |
| widen the search / other titles | `/jobseeker titles` |
| research <market> vendors | `/jobseeker markets <market>` |
| tailor my CV for <posting> | `/tailor <id or url>` |
| apply to <proposal> | `/jobseeker apply <id>` |
| follow up with X | `/jobseeker followup <who>` |
| morning routine | `/jobseeker job-run` |
| set me up / parse my CV | `/jobseeker onboard`, `/jobseeker parse-cv` (or the dashboard wizard `/welcome`) |
| close what I've already done | `/jobseeker reconcile` |
| anything wrong with my tracker | `/jobseeker check` |

## Hard rules (full list in AGENT-RULES.md)

- **All state writes go through `server/record.mjs`**, never hand-edits to `data/` (it locks and writes atomically).
- **Lead vs application:** a sent CV or referral is a lead; an application needs confirmation evidence.
- **Never send a message or submit an application without an approved approval.** (Sends are hook-enforced: `~/.claude/hooks/send_gate.py`.)
- **Chrome is a serial resource:** one Chrome-driving agent at a time.
- **Never guess a person's name from an email/handle.**
- **Run scripts via `npm run <script>` or `node scripts/run.mjs <name>`,** never `bash scripts/<x>.sh` (breaks Windows; hook-enforced). Full suite: `npm test` (`-- --quick` skips the ~100s run-state test).
- **Personal settings live in `config/job-seeker.config.md`** (`company_aliases`, `ignored_chats`); never hardcode them.

Dashboard: `npm run dashboard` → http://localhost:4319 (view/edit only).

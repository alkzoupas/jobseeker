---
description: Build or refresh demand-signal watchlists (companies who likely need your kind of leadership but have no open req yet) from HN Who's Hiring, Wellfound, WeWorkRemotely, and Otta/Welcome to the Jungle. Usage — "/signals" (refresh all markets), "/signals Fintech" (one market).
argument-hint: "[market name]"
---

Build/refresh my demand-signal watchlists. Arguments: `$ARGUMENTS`

This is a different question from `/curate`: `/curate` finds companies with an **open req right
now**; `/signals` finds companies that **probably will need this role but don't have a posting yet**
— hiring-thread chatter, an IC-level req in the domain with no matching leadership req, a public
incident post. A hit here is a **watch-this-company** signal, never a job to apply to (AGENT-RULES
§16). It never writes proposals and never applies to anything.

Interpret the arguments:
- **empty** → refresh signals for **every** market listed in `data/criteria.md` (`markets:` line).
- **`<name>`** → build/refresh just that market.

Steps:
1. `cat data/criteria.md` to read the current `markets:` list.
2. **Launch one `signal-scout` per market, in parallel — at most 3 at a time** (AGENT-RULES §13, same
   cap as `/markets` and `/curate`). Tell each agent exactly which market it owns. They write distinct
   `data/signals/<slug>.md` files, so parallel runs don't collide.
3. **Chrome is serial (AGENT-RULES §13).** If more than one scout needs Wellfound/Otta in the same
   run, they cannot run their browser steps concurrently — have the first one finish its Chrome work
   before the next starts theirs, even though their HN/WeWorkRemotely steps can overlap freely.
4. **Before launching, check for an Otta/Welcome to the Jungle account.** If you don't already know
   the user has one, ask before any scout tries to sign up — creating an account is an outward action
   (AGENT-RULES §0), never something an agent does unprompted. If they say to skip it, tell every
   scout to skip that source and note it in their summary.
5. When they return, give me a combined summary: per market, how many candidates (and how many
   `strong`), any source that was skipped and why, and point out anything a scout flagged as "also has
   an open req" — that's worth a `/curate` pass on that specific company.

Remind me the watchlists are informational: promoting a company to an actual proposal happens only
when `role-scout` finds and verifies a live posting there.

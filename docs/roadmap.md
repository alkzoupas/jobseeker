# Roadmap — considered, not (yet) built

Ideas that came out of a deliberate comparison against another job-search tool
(`career-ops-hq/career-ops`, evaluated 2026-09-10) and were explicitly deferred by the user rather
than rejected. Kept here so they aren't re-derived from scratch next time role-scout's matching
quality comes up. Not a commitment or a schedule — just a record of what was scoped and why it
wasn't built yet.

## 1. Hard dealbreaker gate on proposal scoring

**The gap.** `role-scout`'s overall score is a pure weighted formula (`weight_market * market_score +
weight_role * role_score + weight_cv * cv_match`, from `data/criteria.md`). There's no mechanism to
hard-cap a proposal when a real dealbreaker is violated — below a comp floor, wrong location/visa
requirement, missing a stated must-have. A high `cv_match` can currently outweigh any of those,
pushing a bad-fit role to the top of the ranking instead of zeroing it out.

**What career-ops does instead.** `config/profile.yml`'s `culture_screen.require` hard-caps its
"Cultural signals" dimension at 2/5 when evidence contradicts a required criterion, regardless of how
strong the rest of the match is — explicitly designed so a good CV match can't silently paper over a
violated dealbreaker.

**Sketch of the fix.** Add a `hard_requirements` (or `dealbreakers`) list to `data/criteria.md`
(comp floor, required visa/location, must-have seniority, etc.). When `role-scout` scores a posting
and finds one of these violated, cap the overall score at some low ceiling regardless of the weighted
formula's result, and say so plainly in the rationale ("capped: below stated comp floor") rather than
silently ranking it low. Would touch `data/criteria.md`'s schema, `role-scout.md`'s scoring section,
and possibly `server/record.mjs`'s proposal-scoring helpers if any exist there.

## 2. Posting-legitimacy ("ghost job") flag

**The gap.** A stale or fake-looking listing currently scores purely on content match — nothing flags
"this might not be real." This matters more as recall widens (more sources = more noise to filter);
see the new-company `WebSearch` discovery pass (role-scout.md step 1h) for the most likely source of
noisier hits.

**What career-ops does instead.** Its "Block G" is a reliability-weighted checklist of ghost-job
signals (posting age, vague/duplicate-sounding description, no clear req id, a company with no other
open roles, etc.) — deliberately kept OUT of the numeric score and surfaced to the user separately, so
it informs without silently tanking a real match.

**Sketch of the fix.** A small heuristic checklist run at proposal-write time in `role-scout`,
producing a short flag string in the proposal's rationale (not a score component) — e.g. "posting
legitimacy: unclear (no req id, page last-modified >90 days ago)". Cheap, additive, no schema change
needed beyond what's already free-text in `rationale`.

## Why these weren't built now

Scoped alongside item 5 (bounded `WebSearch` new-company discovery, implemented) during the same
comparison pass, but the user asked to do item 5 only for now and park these two. Revisit when
matching-quality complaints (not recall complaints — item 5 covers that) become concrete, e.g. a
specific proposal that scored too high despite a real dealbreaker, or a specific ghost listing that
wasted a look.

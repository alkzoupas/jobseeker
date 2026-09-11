---
name: sync-upstream
description: Check the jobseeker upstream remote (cventour/jobseeker) for new commits/releases, get a ranked report of what's worth pulling, and merge/cherry-pick on approval. Use for "check upstream", "any updates from upstream/cventour", "should we pull vX.Y.Z", or periodic upstream syncs.
---

# Sync from upstream (cventour/jobseeker)

This repo tracks a public upstream at `https://github.com/cventour/jobseeker.git` (remote name
`upstream`) as well as this fork's own `origin`. Local has diverged with private changes (e.g.
career-ops-hq market-discovery passes, graft indexing, local cron/agent setup) that upstream
doesn't have, and upstream moves independently (installer/dashboard/Windows-script work). The goal
of this skill is to catch anything worth pulling **without burning main-session tokens on a full
diff read**, and never to merge/cherry-pick anything without the user's explicit go-ahead.

## Steps

1. **Fetch, don't read yet.**
   ```
   git fetch upstream --tags
   git merge-base HEAD upstream/main
   git log --oneline HEAD..upstream/main | wc -l
   git log --oneline upstream/main..HEAD | wc -l
   git diff --stat $(git merge-base HEAD upstream/main) upstream/main
   ```
   This is cheap — keep it in the main session. If there are 0 new upstream commits, just report
   "up to date" and stop.

2. **Delegate the actual analysis to a subagent — do not read the full diff yourself.**
   Spawn a `general-purpose` subagent with `model: haiku` (bump to `sonnet`/no override only if
   the diff is unusually large or the commit messages are too terse to judge from). Give it in
   the prompt:
   - The merge-base SHA, the list of changed files (from the diffstat above), and the commit
     counts on each side.
   - Explicit read-only instructions: it may run `git log`, `git show --stat`, `git diff <base>..upstream/main -- <file>`
     freely, but must not check out, merge, reset, or commit anything.
   - What to check for local/upstream collision risk: list local's own commits
     (`git log --oneline HEAD` back to the merge-base) and flag any file both sides touched.
   - What to produce: a ranked list (bug fixes > robustness > features > cosmetic) of upstream
     commits worth pulling, each with its SHA, one line on what it does, and a conflict-risk note;
     plus a recommended approach (merge upstream/main wholesale vs. cherry-pick a subset).

3. **Present the subagent's report to the user verbatim (or lightly trimmed) and stop.** Do not
   merge, cherry-pick, or push anything automatically — this is a review-only skill. Ask the user
   which commits/approach they want, e.g. via AskUserQuestion if the recommendation has real
   trade-offs (full merge vs. selective cherry-pick).

4. **On approval, execute exactly what was agreed** (typically `git cherry-pick <sha>` per
   selected commit, or `git merge upstream/main`), resolve any conflicts, run the test suite /
   sanity checks the user's global CLAUDE.md requires (re-run and quote results — don't just
   claim success), then report the outcome. Never force-push or rewrite shared history.

## Why delegate to a subagent

The diff between forks tends to be large (installer scripts, dashboard.mjs, Windows twins) but
the actual decision — what's worth pulling — only needs a short structured summary, not the raw
diff sitting in the main session's context. A cheap model (Haiku) is enough to read commit
messages and `--stat`/`diff` output and rank them; only escalate to a stronger model if the
subagent's summary is confused or the commits are unusually subtle (e.g. security-relevant
lock/atomicity changes in `server/lock.mjs`).

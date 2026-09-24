Triage job proposals against my fit rubric. Arguments: `$ARGUMENTS`

This replaces me pasting postings into a chat and judging them one by one. It produces a verdict per
role and a table I review. **It never tailors, applies, dismisses or contacts anyone.** Tailoring is
`/tailor <id>`, only when I ask.

## What to triage (from `$ARGUMENTS`)

| `$ARGUMENTS` | Triage |
|---|---|
| empty | every `proposed` proposal without a verdict (`record.mjs list-triage --untriaged`) |
| `all` | every `proposed` proposal again, e.g. after I changed the rubric. My overrides are kept |
| proposal ids | those |
| job URLs | make each a proposal first (below), then triage it |
| pasted job text | make it a proposal first (below), then triage it |
| `#N <BUCKET> <reason>` (one or more) | an **override**, see the last section. Do not re-triage |

**A URL or pasted text that is not a proposal yet:**
1. URL: `node scripts/fetch-jd.mjs --url <url> --id tmp_intake` and read the header + first lines
   for the company and title. Pasted text: save it to a scratch file first. If company or title is
   not clear from the text, ask me.
2. `node server/record.mjs upsert-proposal '{"company":"…","role":"…","location":"…","job_url":"<url or empty>","source":"Manual","status":"proposed","rationale":"Added by /jobseeker triage from a URL/text the user provided."}'`
   This dedupes by company+role and by URL, so a role already tracked is reused.
3. Cache its JD under the proposal id: `node scripts/fetch-jd.mjs <prop-id>` for a URL, or
   `node scripts/fetch-jd.mjs --text-file <file> --id <prop-id>` for pasted text.

## Steps

1. **Rubric present?** `data/fit-rubric.md` must exist and have content beyond its header comment.
   If it doesn't, stop and tell me. Triage without my rubric is guessing.
2. **Fetch the full JDs:** `node scripts/fetch-jd.mjs <ids>` (or `--untriaged`). Add `--browser`
   only when no other agent is driving Chrome (AGENT-RULES §13). In `job-run` that is after curate
   finishes. Note any `thin` / `closed` results for the report.
3. **Code hard filters:** `node scripts/triage.mjs hard-filter`. Binary rubric rules only (closed
   posting, VP/Senior Director titles, non-engineering functions, on-site outside my locations).
   Filtered roles are kept and listed in the report with the rule.
4. **Judge the rest:** `node server/record.mjs list-triage --untriaged` for what is left (for `all`,
   the ids you were given). Spawn **triage-agent** with the Agent tool, **no `model` parameter**
   (its frontmatter says `opus`, AGENT-RULES §16), in batches of at most 10 ids, and **never more
   than 3 agents at once** (§13). Give each batch its ids and nothing else. It reads the rubric
   itself.
5. **Report:** write the agents' returned notes (counts, track spread, least-sure calls, unread JDs,
   rubric gaps) to a scratch file and run
   `node scripts/triage.mjs report --notes <file>`. It writes `output/triage_<date>.md` and
   `output/triage_<date>.json` (row # → proposal id).
6. **Show me the table in chat:** the header line, the table and the Filtered out list from the
   file. Leave out the collapsed board-scan sections, just say they are in the file. Then the file
   path, and: "Tell me any overrides, e.g. `#4 should be SKIP, Foster City 4 days/week is too far`."
7. Log it: `node server/record.mjs log triage "triaged N: A apply, L look closer, S skip, F filtered"`.

## Overrides

When I say `#4 should be SKIP, <reason>` (in any wording), after a triage table or later:
1. Resolve `#4` with the most recent `output/triage_<date>.json` (`rows["4"]` is the proposal id).
   If I name the role instead of a number, find it with `record.mjs list-triage --status any`.
   If it is ambiguous, ask.
2. `node server/record.mjs override <prop-id> <APPLY|LOOK CLOSER|SKIP> <my reason, in my words>`.
   This updates the verdict and appends the row to `data/decisions.md`, which triage-agent reads
   as examples before every run. A later model run never undoes it.
3. Confirm in one line per override. **Do not** also dismiss the proposal or edit the rubric unless
   I ask. If an override reveals a rule the rubric lacks, suggest the rubric change, show me the
   exact edit, and wait.

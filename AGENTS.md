<!-- graft:start -->
## Graft — repo context graph

This repo is indexed in `graft/`: small linked markdown nodes that explain each
system and carry exact file:line spans, kept in sync with the code through git.

For ANY task here — understanding how something works, finding where code lives,
or scoping a change — get context from the graph before grepping or opening
source files. Re-ask freely (it's cheap) and reuse literal identifiers you
already have (symbol, error string, file name) as the query. New to this repo?
Run `graft map` first — a token-budgeted orientation (dir clusters, hubs,
hotspots), no LLM, no key.

- Run `graft ask "<your question>" --source` → ranked nodes with the relevant
  code spans inlined (each hit's ≤8-line crux by default; `--full` for whole
  definitions when the crux isn't enough). Match the tool to the task shape:
  for understanding or editing, the top node IS the answer — cite its
  `covers:` file:line spans and edit straight from `--source`. For
  exhaustive tasks ("every occurrence / every caller of this pattern"), ranked
  results are top-N, not complete — run `graft grep "<literal>"` instead
  (exhaustive over indexed files, grouped by enclosing symbol), falling back
  to raw `grep -rn` only for unindexed files.
- `graft skeleton <file>` → every definition's signature + span, ~10× cheaper
  than reading the file; use it to skim an API surface.
- `graft callers <symbol>` gives precomputed, exact edges — who calls this.
  Add `--direction out` for what it calls, or `--depth N` to walk
  transitively for the full blast radius. For structural questions, skip
  ranking and use this directly.
- Or browse: `graft/INDEX.md` lists every node; follow the links.
- Monorepos and folders of multiple repos rank fairly across sub-projects —
  hits carry `[scope/]` labels naming which one they're from. Narrow with
  `graft ask "<task>" --in <scope>/` once you know where you're working.

If a returned span is truncated ("+N more lines"), open the file at that exact
range before finalizing. Only open source files when a node genuinely lacks a
needed detail, and then at the exact file:line the node points to — never
re-read whole files.

After big code changes, refresh the graph with `graft build` (deterministic,
no API key, $0).
<!-- graft:end -->

## Hindsight — cross-session memory

A local Hindsight memory server may be available at `http://localhost:8888`
(Docker container `hindsight`; not guaranteed to be running on every machine
or environment). This is **best-effort**: if the server isn't reachable,
skip it silently and proceed with the task normally — never block or warn
the user about it. All calls target the `jobseeker` bank.

**Before modifying this repository**, recall relevant memory:

```bash
curl -s -m 5 -X POST http://localhost:8888/v1/default/banks/jobseeker/memories/recall \
  -H "Content-Type: application/json" \
  -d '{"query": "<one line summarizing the task you are about to do>"}'
```

Use the results (architecture, test/build commands, code conventions,
previously failed approaches, unresolved decisions) to orient before making
changes. If the query is broad ("what should I know before touching this
repo"), a `reflect` call synthesizes a direct answer instead of a raw fact
list — it's an agentic loop (several internal recall calls + LLM
synthesis) and can take 60-120s on a local model (much faster on a hosted
API), so use a long timeout and skip it (fall back to `recall`) rather than
block the task on it:

```bash
curl -s -m 120 -X POST http://localhost:8888/v1/default/banks/jobseeker/reflect \
  -H "Content-Type: application/json" \
  -d '{"query": "What should I know before modifying this repo?"}'
```

**At the end of the session**, retain a concise summary of durable technical
decisions and any verified environment or debugging lessons — not a full
transcript, not routine progress narration. Good candidates: an architectural
choice and its rationale, a newly locked invariant, a command or config that
turned out to matter, an approach that was tried and rejected (and why), a
root-caused bug and its fix, or an open question left unresolved.

```bash
curl -s -m 15 -X POST http://localhost:8888/v1/default/banks/jobseeker/memories \
  -H "Content-Type: application/json" \
  -d '{"items": [{"content": "<concise summary>", "context": "<one line: what task/session produced this>"}]}'
```

Skip the retain call entirely if nothing durable came out of the session
(e.g. pure exploration, or a change already fully self-documented in a commit
message or decisions doc) — don't manufacture a summary just to have
something to store.

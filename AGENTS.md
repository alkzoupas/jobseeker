## Graft (code index)

This repo's code is indexed in `graft/`. Before grepping or opening source files, ask it:
`graft ask "<question>" --source` (locate + read), `graft grep "<literal>"` (every occurrence),
`graft skeleton <file>` (a file's API), `graft callers <symbol>` (blast radius). Refresh with
`graft build` after big code changes.

## Hindsight (cross-session memory, best-effort)

Local server at `http://localhost:8888`, bank `jobseeker`. If it doesn't answer, skip it silently.

- Before modifying the repo, recall:
  `curl -s -m 5 -X POST http://localhost:8888/v1/default/banks/jobseeker/memories/recall -H "Content-Type: application/json" -d '{"query": "<the task>"}'`
- At session end, retain only durable technical lessons (decisions and why, root-caused bugs, rejected approaches), never progress narration:
  `curl -s -m 15 -X POST http://localhost:8888/v1/default/banks/jobseeker/memories -H "Content-Type: application/json" -d '{"items": [{"content": "<summary>", "context": "<task>"}]}'`

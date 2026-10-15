#!/usr/bin/env node
// PreToolUse(Write|Edit|MultiEdit|NotebookEdit): the user approves every direct edit to data/.
//
//   * data/** → ask. Nothing is blocked; the user sees the exact change and says yes or no.
//   * AGENT-RULES §18 user-written inputs (some live outside data/) → ask, with their own reason.
//   * anything else → no output (normal permission flow).
//
// Asks only; it doesn't route writes anywhere. Bash redirects into data/ are not covered.
// Run by Claude Code with the hook JSON on stdin. Dependency-free.

import path from "path";

export const USER_INPUTS = [
  "data/fit-rubric.md",
  "data/career-priorities.md",
  "data/decisions.md",
  "templates/cv/trust_resume.tex",
  "templates/cover/voice.md",
  "templates/cover/anchor-stories.md",
];

export function decide(filePath, root) {
  if (!filePath) return null;
  const rel = path.relative(path.resolve(root), path.resolve(root, filePath)).split(path.sep).join("/");
  if (rel.startsWith("../") || path.isAbsolute(rel)) return null;
  if (USER_INPUTS.includes(rel)) {
    return { decision: "ask", reason: `${rel} is a user-written input (AGENT-RULES §18): show the user the exact change and get approval first.` };
  }
  if (rel.startsWith("data/")) {
    return { decision: "ask", reason: `${rel} is tracker state in data/: the user approves direct edits.` };
  }
  return null;
}

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  let input;
  try { input = JSON.parse(raw); } catch { return; }
  const ti = input.tool_input || {};
  const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  const verdict = decide(ti.file_path || ti.notebook_path, root);
  if (!verdict) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: verdict.decision,
      permissionDecisionReason: verdict.reason,
    },
  }) + "\n");
}

if (process.argv[1]?.endsWith("data-guard.mjs")) main();

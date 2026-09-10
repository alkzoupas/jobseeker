#!/usr/bin/env node
// cleanup-scratch.mjs — S1 of the JobSeeker→Hermes migration.
//
// Removes scratch copies under tests/scratch/. Scratch trees are disposable test
// fixtures (a full repo copy each); they must never accumulate or be committed.
//
// Usage:  node tests/harness/cleanup-scratch.mjs [keepN]
//   keepN (optional, default 0) : keep the N most-recent scratch dirs, delete the rest.
//   With no argument (keepN=0) it deletes ALL scratch dirs.
// Refuses to delete anything outside tests/scratch/.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const SCRATCH_ROOT = path.join(ROOT, "tests", "scratch");

const keepN = Math.max(0, parseInt(process.argv[2] ?? "0", 10) || 0);

if (!fs.existsSync(SCRATCH_ROOT)) {
  console.log("[cleanup-scratch] no scratch dir; nothing to do");
  process.exit(0);
}

const dirs = fs.readdirSync(SCRATCH_ROOT, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => ({ name: e.name, mtime: fs.statSync(path.join(SCRATCH_ROOT, e.name)).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime); // newest first

const toDelete = dirs.slice(keepN);
for (const d of toDelete) {
  const full = path.join(SCRATCH_ROOT, d.name);
  // Safety: only ever delete directly under tests/scratch/.
  if (path.dirname(full) !== SCRATCH_ROOT) {
    console.error(`[cleanup-scratch] REFUSING to delete ${full} (not a direct child of scratch)`);
    continue;
  }
  fs.rmSync(full, { recursive: true, force: true });
  console.log(`[cleanup-scratch] removed ${d.name}`);
}

const remaining = fs.existsSync(SCRATCH_ROOT) ? fs.readdirSync(SCRATCH_ROOT).filter((n) => n !== ".gitkeep") : [];
console.log(`[cleanup-scratch] done. ${remaining.length} scratch dir(s) remain.`);

#!/usr/bin/env node
// setup-scratch.mjs — S1 of the JobSeeker→Hermes migration.
//
// Creates a FRESH, fully isolated copy of the repo under tests/scratch/<ts>/ so that
// `node <scratch>/server/record.mjs …` and `node <scratch>/server/config.mjs` resolve
// their hardcoded __dirname-relative paths (ROOT = server/..) into the SCRATCH data/,
// never the live one. This is what lets a skill dry-run without polluting real state.
//
// Why copy the whole repo (not just server/ + data/): record.mjs imports ./config.mjs,
// which reads config/job-seeker.config.md (gitignored but present locally) via the same
// __dirname-relative ROOT. A partial copy would break that import's path resolution.
// Copying everything is cheap (the repo is small) and bulletproof.
//
// Excluded: .git, node_modules (zero runtime deps — nothing to install), tests/scratch
// (avoid recursion into prior scratch copies).
//
// Usage:  node tests/harness/setup-scratch.mjs [label]
//   label (optional) is appended to the timestamp dir name for traceability.
// Prints the absolute scratch path on the last line (machine-readable).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// harness/ -> tests/ -> repo root
const ROOT = path.resolve(__dirname, "..", "..");

const label = process.argv[2] ? `-${process.argv[2].replace(/[^a-z0-9_-]/gi, "")}` : "";
const ts = new Date().toISOString().replace(/[:.]/g, "-");
const scratchDir = path.join(ROOT, "tests", "scratch", `run-${ts}${label}`);

const EXCLUDE = new Set([".git", "node_modules"]);
// Finder junk — never needed in a scratch copy, and it races (recreated/deleted mid-copy).
const SKIP_FILES = new Set([".DS_Store"]);
// Never copy a prior scratch tree into the next one (tests/scratch is where they live).
const SCRATCH_PARENT = path.join(ROOT, "tests", "scratch");

fs.mkdirSync(path.dirname(scratchDir), { recursive: true });

let copied = 0;
function copyTree(src, dest) {
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (EXCLUDE.has(entry.name)) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    // Skip the scratch dir itself when we're at tests/ (avoids copying old runs).
    if (src === path.join(ROOT, "tests") && entry.name === "scratch") continue;
    if (entry.isDirectory()) {
      fs.mkdirSync(d, { recursive: true });
      copyTree(s, d);
    } else if (entry.isFile()) {
      if (SKIP_FILES.has(entry.name)) continue; // .DS_Store etc. — skip, don't race
      try {
        fs.copyFileSync(s, d);
        copied++;
      } catch (err) {
        // A file can vanish between readdir and copy (Finder, editors). Tolerate it;
        // a missing optional file in scratch is harmless. Hard-fail on anything else.
        if (err.code !== "ENOENT") throw err;
      }
    } else if (entry.isSymbolicLink()) {
      // Preserve symlinks as-is (rare; keeps behavior identical to the live tree).
      const target = fs.readlinkSync(s);
      try { fs.symlinkSync(target, d); } catch { /* best-effort */ }
    }
  }
}

console.error(`[setup-scratch] repo root: ${ROOT}`);
console.error(`[setup-scratch] scratch:   ${scratchDir}`);
copyTree(ROOT, scratchDir);

// Sanity: the two things a dry-run depends on must exist in the copy.
const need = [path.join(scratchDir, "server", "record.mjs"), path.join(scratchDir, "data")];
for (const p of need) {
  if (!fs.existsSync(p)) {
    console.error(`[setup-scratch] FATAL: missing ${p} in scratch copy`);
    process.exit(1);
  }
}

console.error(`[setup-scratch] copied ${copied} files`);
// Machine-readable last line: the absolute scratch path.
console.log(scratchDir);

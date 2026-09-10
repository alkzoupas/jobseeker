#!/usr/bin/env node
// run-parity.mjs — S1 of the JobSeeker→Hermes migration.
//
// Diffs two `data/` trees (a reference run vs a candidate run) and reports which
// state files differ, so a skill's output can be compared against a known-good run.
// This is the "parity" primitive: it does NOT judge correctness (that's a human /
// the S12 eyeball), it just makes the delta visible and machine-checkable.
//
// Usage:  node tests/harness/run-parity.mjs <refDataDir> <candDataDir> [--files a.md b.md]
//   refDataDir / candDataDir : absolute paths to two data/ trees (e.g. a snapshot of
//                              the live data/ before a run, and the scratch data/ after).
//   --files (optional)        : restrict the diff to specific files (relative to data/).
//                               Without it, every file present in either tree is compared.
//
// Output (stdout): one line per differing file:  DIFF <relpath>   or   OK <relpath>
// Exit code:      0 if no diffs (or only the --files subset was requested and it matched),
//                 1 if any diff found, 2 on usage/IO error.
//
// Comparison is byte-exact after normalizing trailing whitespace and a final newline,
// because record.mjs rewrites whole files (it is the atomic writer) and we want to
// catch any content drift, not just line counts.

import fs from "node:fs";
import path from "node:path";

function usage() {
  console.error("Usage: node run-parity.mjs <refDataDir> <candDataDir> [--files a.md b.md]");
  process.exit(2);
}

const argv = process.argv.slice(2);
if (argv.length < 2) usage();

let refDir, candDir;
const files = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--files") {
    for (let j = i + 1; j < argv.length; j++) files.push(argv[j]);
    break;
  } else if (argv[i] === refDir || argv[i] === candDir) {
    // already set
  } else if (refDir === undefined) refDir = argv[i];
  else if (candDir === undefined) candDir = argv[i];
}
if (!refDir || !candDir) usage();

const norm = (s) => s.replace(/[ \t]+$/gm, "").replace(/\n+$/, "\n");

function listFiles(dir) {
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && !e.name.startsWith(".")) out.push(path.relative(dir, p));
    }
  })(dir);
  return out;
}

if (!fs.existsSync(refDir) || !fs.existsSync(candDir)) {
  console.error(`[run-parity] FATAL: a data dir does not exist (ref=${fs.existsSync(refDir)}, cand=${fs.existsSync(candDir)})`);
  process.exit(2);
}

let candidates;
if (files.length) {
  candidates = files;
} else {
  const set = new Set([...listFiles(refDir), ...listFiles(candDir)]);
  candidates = [...set].sort();
}

let diffs = 0;
for (const rel of candidates) {
  const a = path.join(refDir, rel);
  const b = path.join(candDir, rel);
  const hasA = fs.existsSync(a) && fs.statSync(a).isFile();
  const hasB = fs.existsSync(b) && fs.statSync(b).isFile();
  if (!hasA || !hasB) {
    console.log(`DIFF ${rel}   (present in ${hasA ? "ref only" : hasB ? "cand only" : "neither"})`);
    diffs++;
    continue;
  }
  const na = norm(fs.readFileSync(a, "utf8"));
  const nb = norm(fs.readFileSync(b, "utf8"));
  if (na === nb) console.log(`OK   ${rel}`);
  else { console.log(`DIFF ${rel}`); diffs++; }
}

console.error(`[run-parity] compared ${candidates.length} file(s): ${diffs} differ`);
process.exit(diffs ? 1 : 0);

#!/usr/bin/env node
// Every `test:*` script in package.json, one after another, with ONE summary line at the end.
//
//   npm test             -> all of them (~2 min; test:runstate alone is ~100s)
//   npm test -- --quick  -> skip the slow ones listed in SLOW
//
// Each suite runs in its own process exactly as `npm run test:<x>` would, but `node …` entries are
// spawned with this Node directly (no npm/shell in between), which keeps it working on Windows.
// A suite's output is only printed when it fails, so a green run stays short.

import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SLOW = new Set(["test:runstate"]);
const quick = process.argv.includes("--quick");

const scripts = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).scripts || {};
const suites = Object.keys(scripts).filter((k) => k.startsWith("test:"));

let passed = 0, failed = 0, skipped = 0;
for (const name of suites) {
  if (quick && SLOW.has(name)) {
    console.log(`- ${name} (skipped: --quick)`);
    skipped++;
    continue;
  }
  const cmd = scripts[name];
  const started = Date.now();
  // Anything quoted or piped needs a real shell to be split correctly.
  const m = /["'`$|&;<>]/.test(cmd) ? null : cmd.match(/^node\s+(.+)$/);
  const r = m
    ? spawnSync(process.execPath, m[1].split(/\s+/), { cwd: ROOT, encoding: "utf8", windowsHide: true })
    : spawnSync(cmd, { cwd: ROOT, encoding: "utf8", shell: true, windowsHide: true });
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  if (r.status === 0) {
    console.log(`✓ ${name} (${secs}s)`);
    passed++;
  } else {
    console.log(`✗ ${name} (${secs}s, exit ${r.status ?? r.signal ?? r.error?.message})`);
    const out = `${r.stdout || ""}${r.stderr || ""}`.trimEnd();
    if (out) console.log(out.replace(/^/gm, "    "));
    failed++;
  }
}

console.log(`test-all: ${passed} passed, ${failed} failed, ${skipped} skipped`);
process.exit(failed ? 1 : 0);

#!/usr/bin/env node
// Regression test for the Hermes agent model configuration.
//
// The bug this guards against: this workspace's agent silently tracks whatever model the
// active Hermes profile happens to resolve to. If the config drifts (model swapped, provider
// re-pointed at a different endpoint, base_url moved), every run in this workspace quietly
// degrades — no error, just a different brain answering. So it gets a test.
//
// Runs `hermes config get model` and asserts stdout carries exactly the local mtplx Qwen setup.
//
//   node scripts/test-hermes-qwen-provider.mjs

import { execFile } from "child_process";
import { promisify } from "util";

const run = promisify(execFile);

const EXPECTED = {
  default: "qwen3.8-27b-mlx-4bit",
  provider: "custom:mtplx",
  base_url: "http://localhost:8000/v1",
};

let failures = 0;

function check(name, ok, detail = "") {
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
}

function finish() {
  console.log(failures === 0 ? "\nPASS\n" : `\nFAIL — ${failures} check(s) failed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

async function main() {
  console.log("\nhermes config get model\n");

  let stdout;
  try {
    ({ stdout } = await run("hermes", ["config", "get", "model"]));
  } catch (e) {
    check("hermes config get model runs", false, e?.message || String(e));
    finish();
    return;
  }

  // `hermes config get model` prints "key: value" lines. Split only on the FIRST colon —
  // values like http://localhost:8000/v1 and custom:mtplx contain their own colons.
  const actual = Object.fromEntries(
    stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l)
      .map((l) => {
        const i = l.indexOf(":");
        return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
      })
  );

  // 1. Every expected value is present and exact.
  for (const [key, value] of Object.entries(EXPECTED)) {
    check(
      `${key} is "${value}"`,
      actual[key] === value,
      actual[key] === undefined ? `key "${key}" missing from output` : `got "${actual[key]}"`
    );
  }

  // 2. Exactly these values, nothing more: no extra keys in the output.
  const unexpected = Object.keys(actual).filter((k) => !(k in EXPECTED));
  check("no unexpected keys in output", unexpected.length === 0, unexpected.join(", "));

  finish();
}

main().catch((e) => {
  console.error("test-hermes-qwen-provider error:", e?.message || e);
  process.exit(1);
});

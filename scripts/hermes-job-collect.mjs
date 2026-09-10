#!/usr/bin/env node
// Deterministic, read-only Gmail collection contract for the job-search agent.

import { promises as fs } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(__dirname, "..");
//
// buildGmailSearchArgs({ days, max }) returns the exact argv (after the `gog`
// executable) used to collect job-related mail. It never sends, never mutates,
// and bounds both the time window and the result count so a scheduled run can
// never spiral into an unbounded or write-capable fetch.

const MIN_DAYS = 1;
const MAX_DAYS = 30;
const MIN_MAX = 1;
const MAX_MAX = 500;

// Job-related search terms, OR-joined. Gmail matches any of them.
const JOB_TERMS = [
  "interview",
  "recruiter",
  "application",
  "resume",
  "job offer",
  "hiring",
  "career",
  "opportunity",
];

function isBoundedInt(value, min, max, label) {
  const ok = Number.isInteger(value) && value >= min && value <= max;
  if (!ok) {
    throw new RangeError(
      `${label} must be an integer between ${min} and ${max} (got ${JSON.stringify(value)})`
    );
  }
}

/**
 * Build the `gog` argv for a bounded, read-only Gmail search of job mail.
 *
 * @param {object} opts
 * @param {number} opts.days  Lookback window in days (integer, 1..30).
 * @param {number} opts.max   Result-count bound (integer, 1..500).
 * @returns {string[]} Arguments to pass after the `gog` executable:
 *   [ "gmail", "search", <bounded query>, "--gmail-no-send",
 *     "--readonly", "--json", "--max", String(max) ]
 */
export function buildGmailSearchArgs({ days, max } = {}) {
  isBoundedInt(days, MIN_DAYS, MAX_DAYS, "days");
  isBoundedInt(max, MIN_MAX, MAX_MAX, "max");

  const terms = JOB_TERMS.map((term) => (term.includes(" ") ? `"${term}"` : term)).join(" OR ");
  const query = `(${terms}) newer_than:${days}d`;

  return [
    "gmail",
    "search",
    query,
    "--gmail-no-send",
    "--readonly",
    "--json",
    "--results-only",
    "--max",
    String(max),
  ];
}

/**
 * Collect job-related Gmail mail through the injected `run` runner.
 *
 * Calls `run("gog", buildGmailSearchArgs({ days, max }))`, JSON-parses the
 * stdout, and returns the records. Never throws: any runner error, malformed
 * JSON, or non-array payload is reported as
 * `{ state: "failed", records: [], error: <safe string> }`.
 *
 * @param {object} opts
 * @param {number} opts.days   Lookback window in days (1..30).
 * @param {number} opts.max    Result-count bound (1..500).
 * @param {(bin: string, argv: string[]) => Promise<{stdout?: string}>} opts.run
 *        Injected command runner; receives the executable name and argv.
 * @returns {Promise<{state: "complete"|"failed", records: object[], error?: string}>}
 */
export async function collectGmail({ days, max, run } = {}) {
  if (typeof run !== "function") {
    return { state: "failed", records: [], error: "run is not a function" };
  }

  let argv;
  try {
    argv = buildGmailSearchArgs({ days, max });
  } catch {
    return { state: "failed", records: [], error: "invalid collection bounds" };
  }

  let stdout;
  try {
    const result = await run("gog", argv);
    stdout = result?.stdout;
  } catch {
    return { state: "failed", records: [], error: "gog command failed" };
  }

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { state: "failed", records: [], error: "gog output was not valid JSON" };
  }

  if (!Array.isArray(parsed)) {
    return { state: "failed", records: [], error: "gog output was not a JSON array" };
  }

  return { state: "complete", records: parsed };
}

// Fixed, read-only "static context" commands for the daily run. Every command
// runs through `node` with a plain argv — no shell, no chaining, no writes.
// Paths are relative to the repository root (the runner resolves the cwd).
const STATIC_CONTEXT_COMMANDS = [
  { key: "gmail_watermark", bin: "node", argv: ["server/record.mjs", "get-watermark", "gmail"] },
  { key: "a16z_watermark", bin: "node", argv: ["server/record.mjs", "get-watermark", "a16z-digest"] },
  { key: "keys", bin: "node", argv: ["server/record.mjs", "list-keys"] },
  { key: "boards", bin: "node", argv: ["server/record.mjs", "list-boards"] },
  { key: "url_health", bin: "node", argv: ["scripts/check-urls.mjs", "--json"] },
  { key: "audit", bin: "node", argv: ["server/audit.mjs"] },
];

/**
 * Build the fixed set of static-context commands for a daily run.
 *
 * The audit command is dated with the explicit `today` ISO date as its final
 * argv entry so scheduled runs never drift by ambient clock.
 *
 * @param {object} opts
 * @param {string} opts.today ISO date (yyyy-mm-dd) stamped onto the audit command.
 * @returns {{key: string, bin: string, argv: string[]}[]}
 */
export function buildStaticContextCommands({ today } = {}) {
  return STATIC_CONTEXT_COMMANDS.map((command) => {
    const argv =
      command.key === "audit" && today !== undefined
        ? [...command.argv, String(today)]
        : [...command.argv];
    return { key: command.key, bin: command.bin, argv };
  });
}

/**
 * Collect all static-context commands through the injected `run` runner.
 *
 * Each command's stdout is JSON-parsed into `results[key]`. A command that
 * throws or yields malformed JSON is reported per-key in `coverage`
 * (`{ state: "failed", error }`) and never throws out of the collector.
 *
 * @param {object} opts
 * @param {string} opts.today ISO date (yyyy-mm-dd) stamped onto the audit command.
 * @param {(bin: string, argv: string[]) => Promise<{stdout?: string}>} opts.run
 *        Injected command runner; receives the executable name and argv.
 * @returns {Promise<{state: "complete"|"partial", results: object, coverage: object}>}
 *   `complete` when every command parsed; `partial` otherwise.
 */
export async function collectStaticContext({ today, run } = {}) {
  if (typeof run !== "function") {
    return { state: "partial", results: {}, coverage: {} };
  }

  const commands = buildStaticContextCommands({ today });
  const results = {};
  const coverage = {};
  let allOk = true;

  for (const command of commands) {
    let parsed;
    try {
      const result = await run(command.bin, command.argv);
      parsed = JSON.parse(result?.stdout);
    } catch (error) {
      allOk = false;
      coverage[command.key] = {
        state: "failed",
        error: String(error?.message || error),
      };
      continue;
    }
    results[command.key] = parsed;
    coverage[command.key] = { state: "ok" };
  }

  return { state: allOk ? "complete" : "partial", results, coverage };
}

// Browser collection stays deliberately mechanical: probe first, trust only the
// JSON status the probe wrote, and use the permanent BrowserAgent entrypoint for
// a bounded board sweep. It never drives Chrome directly.
export async function collectBrowserContext({ boardMax = 15, run, readFile } = {}) {
  if (!Number.isInteger(boardMax) || boardMax < 0 || boardMax > 15) {
    return { state: "partial", coverage: { browser: { state: "failed", error: "invalid board sweep bound" } } };
  }
  if (typeof run !== "function" || typeof readFile !== "function") {
    return { state: "partial", coverage: { browser: { state: "failed", error: "browser collector dependencies unavailable" } } };
  }

  let status;
  try {
    await run("node", ["scripts/browser-probe.mjs"]);
    status = JSON.parse(await readFile("data/.browser-status.json", "utf8"));
  } catch {
    return { state: "partial", coverage: { browser: { state: "failed", error: "browser probe failed" } } };
  }

  if (!status?.capabilities?.read_page_content) {
    return {
      state: "partial",
      status,
      coverage: { browser: { state: "unavailable", blockers: Array.isArray(status?.blockers) ? status.blockers : [] } },
    };
  }

  if (boardMax === 0) {
    return {
      state: "complete",
      status,
      board_sweep: "",
      coverage: { browser: { state: "complete", mechanism: status.capabilities.read_mechanism }, board_sweep: { state: "skipped", max: 0 } },
    };
  }

  try {
    const sweep = await run("node", ["scripts/browser-do.mjs", "board-sweep", "--max", String(boardMax)]);
    return {
      state: "complete",
      status,
      board_sweep: String(sweep?.stdout || ""),
      coverage: { browser: { state: "complete", mechanism: status.capabilities.read_mechanism }, board_sweep: { state: "complete", max: boardMax } },
    };
  } catch {
    return {
      state: "partial",
      status,
      coverage: { browser: { state: "complete", mechanism: status.capabilities.read_mechanism }, board_sweep: { state: "failed", error: "browser board sweep failed" } },
    };
  }
}

// Compact, explicit hand-off to Qwen. Raw collection failures remain visible in
// coverage; the model never needs to infer what was or was not actually read.
export function buildRunContext({ started, gmail = {}, staticContext = {}, browser = {} } = {}) {
  const coverage = {
    gmail: { state: gmail.state === "complete" ? "complete" : "failed", ...(gmail.error ? { error: gmail.error } : {}) },
    ...(staticContext.coverage || {}),
    ...(browser.coverage || {}),
  };
  const sourceStates = [gmail.state, staticContext.state, browser.state];
  return {
    schema_version: 1,
    started: String(started || new Date().toISOString()),
    state: sourceStates.every((state) => state === "complete") ? "complete" : "partial",
    coverage,
    gmail: { records: Array.isArray(gmail.records) ? gmail.records : [] },
    static: staticContext.results || {},
    browser: { status: browser.status || null, board_sweep: browser.board_sweep || null },
  };
}

export async function writeRunContext({ root = DEFAULT_ROOT, context } = {}) {
  const data = path.join(root, "data");
  const file = path.join(data, ".hermes-job-run-context.json");
  await fs.mkdir(data, { recursive: true });
  const temp = `${file}.tmp.${process.pid}.${randomUUID()}`;
  await fs.writeFile(temp, `${JSON.stringify(context, null, 2)}\n`, "utf8");
  await fs.rename(temp, file);
  return file;
}

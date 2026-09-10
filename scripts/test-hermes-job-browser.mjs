#!/usr/bin/env node
// Regression tests for the safe browser collector contract.

import { collectBrowserContext } from "./hermes-job-collect.mjs";

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
};

async function main() {
  const calls = [];
  const readableStatus = {
    capabilities: { read_page_content: true, read_mechanism: "apple-events" },
    blockers: [],
  };
  const readable = await collectBrowserContext({
    boardMax: 3,
    run: async (bin, argv) => { calls.push([bin, argv]); return { stdout: "ok" }; },
    readFile: async () => JSON.stringify(readableStatus),
  });
  check("runs the authoritative browser probe", JSON.stringify(calls[0]) === JSON.stringify(["node", ["scripts/browser-probe.mjs"]]), JSON.stringify(calls));
  check("uses BrowserAgent board sweep only", JSON.stringify(calls[1]) === JSON.stringify(["node", ["scripts/browser-do.mjs", "board-sweep", "--max", "3"]]), JSON.stringify(calls));
  check("reports readable browser coverage", readable.state === "complete" && readable.coverage.browser.state === "complete", JSON.stringify(readable));

  const emptyBoardCalls = [];
  const emptyBoards = await collectBrowserContext({
    boardMax: 0,
    run: async (bin, argv) => { emptyBoardCalls.push([bin, argv]); return { stdout: "ok" }; },
    readFile: async () => JSON.stringify(readableStatus),
  });
  check("does not sweep when there are no browser boards", emptyBoardCalls.length === 1, JSON.stringify(emptyBoardCalls));
  check("records skipped zero-board sweep", emptyBoards.state === "complete" && emptyBoards.coverage.board_sweep.state === "skipped", JSON.stringify(emptyBoards));

  const unavailableCalls = [];
  const unavailable = await collectBrowserContext({
    boardMax: 3,
    run: async (bin, argv) => { unavailableCalls.push([bin, argv]); return { stdout: "ok" }; },
    readFile: async () => JSON.stringify({ capabilities: { read_page_content: false, read_mechanism: "none" }, blockers: ["Automation denied"] }),
  });
  check("does not sweep unreadable browser", unavailableCalls.length === 1, JSON.stringify(unavailableCalls));
  check("reports unavailable browser coverage", unavailable.state === "partial" && unavailable.coverage.browser.state === "unavailable" && unavailable.status.blockers[0] === "Automation denied", JSON.stringify(unavailable));

  const failed = await collectBrowserContext({ boardMax: 3, run: async () => { throw new Error("broker down"); }, readFile: async () => "{}" });
  check("reports probe failure without throwing", failed.state === "partial" && failed.coverage.browser.state === "failed");

  console.log(failures === 0 ? "\nPASS\n" : `\nFAIL — ${failures} check(s) failed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => { console.error("test-hermes-job-browser error:", error?.message || error); process.exit(1); });

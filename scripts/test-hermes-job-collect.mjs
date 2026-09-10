#!/usr/bin/env node
// Regression tests for the deterministic, read-only Gmail command contract.

import { buildGmailSearchArgs, buildStaticContextCommands, collectGmail, collectStaticContext } from "./hermes-job-collect.mjs";

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
};

async function main() {
  const args = buildGmailSearchArgs({ days: 7, max: 25 });
  const query = args[2] || "";

  check("uses gog gmail search", args.slice(0, 2).join(" ") === "gmail search", args.slice(0, 2).join(" "));
  check("uses a bounded newer_than query", /newer_than:7d/.test(query), query);
  check("searches job-related mail", /interview|recruiter|application/.test(query), query);
  check("blocks send operations", args.includes("--gmail-no-send"), args.join(" "));
  check("uses read-only API mode", args.includes("--readonly"), args.join(" "));
  check("uses JSON output", args.includes("--json"), args.join(" "));
  check("drops unneeded response envelope", args.includes("--results-only"), args.join(" "));
  check("bounds result count", args.includes("--max") && args[args.indexOf("--max") + 1] === "25", args.join(" "));
  check("rejects zero-day window", (() => { try { buildGmailSearchArgs({ days: 0 }); return false; } catch { return true; } })());
  check("rejects an unbounded max", (() => { try { buildGmailSearchArgs({ days: 7, max: 501 }); return false; } catch { return true; } })());

  const calls = [];
  const complete = await collectGmail({
    days: 2,
    max: 3,
    run: async (bin, argv) => {
      calls.push([bin, argv]);
      return { stdout: '[{"id":"thread-1","subject":"Interview invite"}]' };
    },
  });
  check("collector calls only gog", calls.length === 1 && calls[0][0] === "gog", JSON.stringify(calls));
  check("collector forwards safe arguments", calls[0]?.[1].includes("--gmail-no-send") && calls[0]?.[1].includes("--readonly"));
  check("collector returns parsed records", complete.state === "complete" && complete.records?.[0]?.id === "thread-1", JSON.stringify(complete));
  check("collector records failed command coverage", (await collectGmail({ days: 2, max: 3, run: async () => { throw new Error("token revoked"); } })).state === "failed");
  check("collector records malformed JSON coverage", (await collectGmail({ days: 2, max: 3, run: async () => ({ stdout: "not JSON" }) })).state === "failed");

  const staticCommands = buildStaticContextCommands({ today: "2026-09-10" });
  check("static collector has fixed command set", staticCommands.map((c) => c.key).join(",") === "gmail_watermark,a16z_watermark,keys,boards,url_health,audit", JSON.stringify(staticCommands));
  check("static collector uses exact repository entrypoints", JSON.stringify(staticCommands.map((c) => c.argv)) === JSON.stringify([
    ["server/record.mjs", "get-watermark", "gmail"],
    ["server/record.mjs", "get-watermark", "a16z-digest"],
    ["server/record.mjs", "list-keys"],
    ["server/record.mjs", "list-boards"],
    ["scripts/check-urls.mjs", "--json"],
    ["server/audit.mjs", "2026-09-10"],
  ]), JSON.stringify(staticCommands));
  check("static collector uses no shell", staticCommands.every((c) => c.bin === "node" && Array.isArray(c.argv) && !c.argv.join(" ").includes(";")));
  check("static collector dates its audit", staticCommands.find((c) => c.key === "audit")?.argv.at(-1) === "2026-09-10");
  const staticResult = await collectStaticContext({
    today: "2026-09-10",
    run: async (_bin, argv) => ({ stdout: JSON.stringify({ command: argv[1] }) }),
  });
  check("static collector returns every parsed result", staticResult.state === "complete" && Object.keys(staticResult.results).length === 6, JSON.stringify(staticResult));
  const staticPartial = await collectStaticContext({
    today: "2026-09-10",
    run: async (_bin, argv) => {
      if (argv.includes("list-boards")) throw new Error("offline");
      return { stdout: "{}" };
    },
  });
  check("static collector reports partial coverage", staticPartial.state === "partial" && staticPartial.coverage.boards.state === "failed");

  console.log(failures === 0 ? "\nPASS\n" : `\nFAIL — ${failures} check(s) failed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("test-hermes-job-collect error:", error?.message || error);
  process.exit(1);
});

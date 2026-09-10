// End-to-end deterministic wiring for one Hermes/Qwen JobSeeker daily run.

import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execFile } from "child_process";
import { promisify } from "util";
import { collectBrowserContext, collectGmail, collectStaticContext, buildRunContext, writeRunContext } from "./hermes-job-collect.mjs";
import { createRunManager } from "./hermes-job-run.mjs";
import { finalizeDigest, formatDigest } from "./hermes-job-finalize.mjs";

const exec = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(__dirname, "..");
const dateLabel = (date) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "America/Los_Angeles" }).format(date);
const timeLabel = (date) => new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "America/Los_Angeles" }).format(date);

const defaultRun = (bin, argv, cwd) => exec(bin, argv, { cwd, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });

function modelPayload(raw) {
  const text = String(raw);
  const parseObjectAt = (start) => {
    let depth = 0, quote = false, escape = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (quote) {
        if (escape) escape = false;
        else if (ch === "\\") escape = true;
        else if (ch === '"') quote = false;
        continue;
      }
      if (ch === '"') { quote = true; continue; }
      if (ch === "{") depth++;
      if (ch === "}") {
        depth--;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
    return null;
  };
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    const candidate = parseObjectAt(start);
    if (!candidate) continue;
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
    } catch { /* model prose may contain a non-JSON brace before the payload */ }
  }
  throw new Error("model output did not contain a JSON object");
}

export async function runDaily({ root = DEFAULT_ROOT, now = new Date(), run, readFile, invokeModel } = {}) {
  const command = run || ((bin, argv) => defaultRun(bin, argv, root));
  const read = readFile || ((file, encoding) => fs.readFile(path.join(root, file), encoding));
  const manager = createRunManager({ root });
  const started = now.toISOString();
  const active = await manager.start({ detail: "Hermes/Qwen daily run started", coverage: {} });
  let finalStatus;
  try {
    const [gmail, staticContext] = await Promise.all([
      collectGmail({ days: 14, max: 50, run: command }),
      collectStaticContext({ today: started.slice(0, 10), run: command }),
    ]);
    const access = staticContext.results?.boards?.by_access || {};
    const boardMax = Number(access.browser || 0) + Number(access.blocked || 0) > 0 ? 15 : 0;
    const browser = await collectBrowserContext({ boardMax, run: command, readFile: read });
    const context = buildRunContext({ started, gmail, staticContext, browser });
    const contextPath = await writeRunContext({ root, context });
    let payload;
    try {
      if (typeof invokeModel !== "function") throw new Error("model invoker unavailable");
      payload = modelPayload(await invokeModel(contextPath));
    } catch (error) {
      payload = { highlights: ["Daily Qwen interpretation failed; no tracker changes were made."], postings: [], followups: [], coverage: [`Model: ${String(error?.message || error).slice(0, 180)}`], system: ["Review the local Qwen/Hermes model configuration."] };
      context.state = "partial";
      context.coverage.model = { state: "failed", error: String(error?.message || error).slice(0, 180) };
    }
    const coverage = Object.entries(context.coverage).filter(([, value]) => value?.state !== "complete" && value?.state !== "ok").map(([key, value]) => `${key}: ${value?.error || value?.blockers?.join("; ") || value?.state}`);
    const state = context.state === "complete" ? "ok" : "partial";
    const finished = new Date();
    finalStatus = { state, started, finished: finished.toISOString(), detail: "Hermes/Qwen daily run completed", coverage: context.coverage };
    const digest = formatDigest({ date: dateLabel(now), completed: timeLabel(finished), started: timeLabel(now), state, highlights: payload.highlights, postings: payload.postings, followups: payload.followups, coverage: [...coverage, ...(Array.isArray(payload.coverage) ? payload.coverage : [])], system: payload.system });
    await finalizeDigest({ root, digest, status: finalStatus });
    await manager.finish(active, finalStatus);
    return { state, context_path: contextPath };
  } catch (error) {
    finalStatus = { state: "failed", started, finished: new Date().toISOString(), detail: String(error?.message || error).slice(0, 300), coverage: {} };
    const digest = formatDigest({ date: dateLabel(now), completed: timeLabel(new Date()), started: timeLabel(now), state: "failed", highlights: ["Daily run failed before interpretation."], system: [finalStatus.detail] });
    await finalizeDigest({ root, digest, status: finalStatus });
    await manager.finish(active, finalStatus);
    return { state: "failed" };
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const invokeModel = async (contextPath) => {
    const prompt = [
      "Run the trusted jobseeker-qwen-daily skill.",
      `Read the bounded context at ${contextPath}.`,
      "This digest canary is read-only: do not call terminal and do not modify tracker files.",
      "Return ONLY valid JSON with exactly these array keys: highlights, postings, followups, coverage, system.",
      "Do not send, apply, or use Claude.",
    ].join(" ");
    const { stdout } = await exec("hermes", ["-s", "jobseeker-qwen-daily", "-t", "file", "-z", prompt], { cwd: DEFAULT_ROOT, timeout: 20 * 60_000, maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  };
  runDaily({ invokeModel })
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => { process.stderr.write(`hermes-job-daily error: ${error?.message || error}\n`); process.exit(1); });
}

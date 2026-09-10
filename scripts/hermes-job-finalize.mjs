// Deterministic renderer and durable writer for the Hermes/Qwen daily digest.

import { promises as fs } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(__dirname, "..");
const short = (value) => String(value ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, 500);
const items = (value, limit, name) => {
  const result = Array.isArray(value) ? value : [];
  if (result.length > limit) throw new RangeError(`${name} may contain at most ${limit} entries`);
  return result;
};

export function formatDigest({ date = "", completed = "", started = "", state = "failed", highlights = [], postings = [], followups = [], coverage = [], system = [] } = {}) {
  const safeHighlights = items(highlights, 6, "highlights").map(short).filter(Boolean);
  const safePostings = items(postings, 5, "postings");
  const safeFollowups = items(followups, 6, "followups").map(short).filter(Boolean);
  const safeCoverage = items(coverage, 20, "coverage").map(short).filter(Boolean);
  const safeSystem = items(system, 10, "system").map(short).filter(Boolean);
  const lines = [
    "not-delivered: Telegram delivery delegated to Hermes cron",
    `Update of ${short(date)} Completed at ${short(completed)}`,
    `Started ${short(started)} · ${short(state)}`,
    "",
    "Highlights",
    ...(safeHighlights.length ? safeHighlights.map((item) => `- ${item}`) : ["- None."]),
    "",
    "New Job Postings",
  ];
  if (!safePostings.length) lines.push("None found today.");
  for (const posting of safePostings) {
    lines.push(`${short(posting.company)} - ${short(posting.role)}`);
    if (short(posting.url)) lines.push(short(posting.url));
  }
  lines.push("", "Follow ups for Today", ...(safeFollowups.length ? safeFollowups.map((item) => `- ${item}`) : ["- None."]));
  if (safeCoverage.length) lines.push("", "Coverage", ...safeCoverage.map((item) => `- ${item}`));
  if (safeSystem.length) lines.push("", "System", ...safeSystem.map((item) => `- ${item}`));
  return `${lines.join("\n")}\n`;
}

async function atomicWrite(file, content) {
  const temp = `${file}.tmp.${process.pid}.${randomUUID()}`;
  await fs.writeFile(temp, content, "utf8");
  await fs.rename(temp, file);
}

export async function finalizeDigest({ root = DEFAULT_ROOT, digest, status } = {}) {
  if (typeof digest !== "string" || !digest.startsWith("not-delivered:")) throw new Error("A durable digest is required");
  if (!status || typeof status !== "object") throw new Error("A final status object is required");
  const data = path.join(root, "data");
  const digestFile = path.join(data, ".last-digest.md");
  const statusFile = path.join(data, ".hermes-job-run.status.json");
  await fs.mkdir(data, { recursive: true });
  await atomicWrite(digestFile, digest);
  await atomicWrite(statusFile, `${JSON.stringify(status, null, 2)}\n`);
  return { digest_file: digestFile, status_file: statusFile };
}

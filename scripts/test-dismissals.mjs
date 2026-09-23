#!/usr/bin/env node
// Guards the avoid-term miner behind `record.mjs dismissal-patterns`. Its output is a DO-NOT-PROPOSE
// list for role-scout and a flag in the board scan, so a wrong term silently suppresses real roles.
// It happened: "machine learning" was mined from "not my domain" dismissals while Machine Learning
// was one of the user's four target markets, because only the target ROLES were protected.
//
//   npm run test:dismissals

import { protectedTermWords, titleTerms } from "../server/record.mjs";

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
};

const criteria = { roles: "Engineering Manager", markets: "Trust & Safety, Machine Learning, Maritime Tech" };
const prot = protectedTermWords(criteria);
check("role words are protected", prot.has("engineering") && prot.has("manager"));
check("market words are protected", prot.has("machine") && prot.has("learning") && prot.has("safety") && prot.has("maritime"));
check("short words are not", !prot.has("ml"));

const rejected = [
  "Engineering Manager, Machine Learning Platform",
  "Senior Manager, Machine Learning Infrastructure",
  "Engineering Manager, Red Team",
  "Manager, Red Team Operations",
  "Ads Safety Engineering Manager",
  "Ads Safety Lead",
];
const terms = titleTerms(rejected, prot).map((t) => t.term);
check("a target MARKET never becomes an avoid-term", !terms.some((t) => /machine|learning|safety/.test(t)), terms.join(", "));
check("a target ROLE word never becomes an avoid-term", !terms.some((t) => /engineering|manager/.test(t)));
check("a genuinely rejected shape still does", terms.includes("red team"), terms.join(", "));
check("with nothing protected, the market term WOULD be mined (the old bug)", titleTerms(rejected).some((t) => t.term === "machine learning"));
check("empty criteria protects nothing", protectedTermWords({}).size === 0);

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);

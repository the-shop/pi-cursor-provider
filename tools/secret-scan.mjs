import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, relative } from "node:path";

const PATTERNS = [
  { name: "OpenAI-style key", re: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { name: "Anthropic key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: "GitHub token", re: /\b(gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}/ },
  { name: "Slack token", re: /\bxox[bpas]-[0-9A-Za-z-]{10,}/ },
  { name: "AWS access key", re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "Private key block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "Bearer token literal", re: /Bearer\s+[A-Za-z0-9._-]{30,}/ },
  { name: "Assigned secret", re: /(?:api[_-]?key|secret|token|password)\s*[:=]\s*["'][A-Za-z0-9_\-./+]{16,}["']/i },
];

function knownSecrets() {
  const directory = join(homedir(), ".pi", "agent", "secrets");
  const values = [];
  if (!existsSync(directory)) return values;
  for (const entry of readdirSync(directory)) {
    if (!entry.endsWith(".env")) continue;
    let body;
    try {
      body = readFileSync(join(directory, entry), "utf8");
    } catch {
      continue;
    }
    for (const match of body.matchAll(/^\s*(?:export\s+)?[A-Z0-9_]+\s*=\s*"?([^"\n#]{12,})"?/gm)) {
      const value = match[1].trim();
      if (!value || /^https?:|^\/|^\$/.test(value)) continue;
      values.push({ source: entry, value });
    }
  }
  return values;
}

const ROOT = process.cwd();
const SKIP = /(^|\/)(node_modules|\.git|patches)\//;
const TEXTY = /\.(ts|js|mjs|cjs|json|md|txt|ya?ml|env|sh|toml|cfg|ini)$|(^|\/)(\.gitignore|LICENSE)$/;
const LEGAL = new Set(["LICENSE", "THIRD_PARTY.md"]);
const secrets = knownSecrets();
const localValues = [
  { name: "local home path", value: homedir() },
  ...(hostname().length >= 6 ? [{ name: "local hostname", value: hostname() }] : []),
];

function filesUnder(root) {
  const files = [];
  const walk = (directory, depth) => {
    if (depth > 6) return;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(directory, entry.name);
      if (SKIP.test(full + "/")) continue;
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (TEXTY.test(full)) files.push(full);
    }
  };
  walk(root, 0);
  return files;
}

const findings = [];
const findingKeys = new Set();
function report(file, why) {
  const key = `${file}\0${why}`;
  if (findingKeys.has(key)) return;
  findingKeys.add(key);
  findings.push({ file, why });
}

function scan(file, body, patternScan = true) {
  const rel = relative(ROOT, file) || file;
  if (patternScan && !file.endsWith("secret-scan.mjs")) {
    for (const { name, re } of PATTERNS) {
      if (re.test(body)) report(rel, name);
    }
  }
  for (const { source, value } of secrets) {
    if (body.includes(value)) report(rel, `literal value from ${source}`);
  }
  for (const { name, value } of localValues) {
    if (value && body.includes(value)) report(rel, name);
  }
  if (!LEGAL.has(rel) && /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(body)) {
    report(rel, "personal email address");
  }
}

for (const file of filesUnder(ROOT)) {
  try {
    scan(file, readFileSync(file, "utf8"));
  } catch {
    // A disappearing generated file is not part of the release surface.
  }
}

let tracked = "";
try {
  tracked = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" });
} catch {
  // The working-tree scan above remains useful outside a git checkout.
}
for (const rel of tracked.split("\n").filter(Boolean)) {
  try {
    scan(join(ROOT, rel), readFileSync(join(ROOT, rel), "utf8"), false);
  } catch {
    // Ignore deleted or binary tracked paths.
  }
}

if (findings.length === 0) {
  console.log("secret-scan: clean (credentials, known values, and local identity markers)");
  process.exit(0);
}

console.error("secret-scan: FAILED — do not commit\n");
for (const finding of findings) console.error(`  ${finding.file}\n    ${finding.why}`);
console.error(`\n${findings.length} finding(s). Remove sensitive or machine-specific content before release.`);
process.exit(1);

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const forbidden = [
  /\bconsole\.(?:log|debug|info|warn|error)\s*\(/,
  /\bprocess\.stdout\.write\s*\(/,
  /\bprocess\.stderr\.write\s*\(/,
];
const violations = [];

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (["node_modules", "debug", "dist"].includes(entry)) continue;
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      walk(path);
      continue;
    }
    if (!path.endsWith(".ts")) continue;
    const text = readFileSync(path, "utf-8");
    for (const pattern of forbidden) {
      if (pattern.test(text)) violations.push(`${path}: ${pattern}`);
    }
  }
}

walk(root);

if (violations.length > 0) {
  throw new Error(`Terminal output API usage is forbidden in extension code:\n${violations.join("\n")}`);
}

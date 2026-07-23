import { existsSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const buildDir = mkdtempSync(join(tmpdir(), "kiro-pi-test-"));
const tscPath = join(root, "node_modules", "typescript", "bin", "tsc");

let exitCode = 0;

try {
  const compile = spawnSync(process.execPath, [tscPath, "--outDir", buildDir, "--noEmit", "false"], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env },
  });
  if (compile.error) throw compile.error;
  if (compile.status !== 0) {
    exitCode = compile.status ?? 1;
  } else {
    writeFileSync(join(buildDir, "package.json"), JSON.stringify({ type: "module" }), "utf-8");
    const nodeModulesPath = join(root, "node_modules");
    if (existsSync(nodeModulesPath)) symlinkSync(nodeModulesPath, join(buildDir, "node_modules"), "junction");
    // Enumerate test files explicitly: `node --test <glob>` only expands globs
    // on Node 21+, so a literal `tests/*.test.mjs` fails on Node 20.
    const testFiles = readdirSync(join(root, "tests"))
      .filter((file) => file.endsWith(".test.mjs"))
      .sort()
      .map((file) => join("tests", file));
    if (testFiles.length === 0) throw new Error("No test files found in tests/.");
    const test = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...testFiles], {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, PI_KIRO_PROVIDER_BUILD_DIR: buildDir },
    });
    if (test.error) throw test.error;
    exitCode = test.status ?? 1;
  }
} finally {
  rmSync(buildDir, { recursive: true, force: true });
}

process.exit(exitCode);

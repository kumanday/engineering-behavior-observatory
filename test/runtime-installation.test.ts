import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installRuntime, verifyInstalledRuntime, type RuntimeInstallPlan } from "../src/runtime-installation.js";

const plan: RuntimeInstallPlan = { kind: "npm", platform: "darwin-arm64", abi: "node-24", recipe: "ebo-npm/v1", packageJson: { name: "ebo-study-runtime", version: "1.0.0", private: true, dependencies: { example: "9.9.9" } },
  packageLock: { name: "ebo-study-runtime", lockfileVersion: 3, packages: { "": { dependencies: { example: "9.9.9" } }, "node_modules/example": { version: "9.9.9", resolved: "https://registry.npmjs.org/example.tgz", integrity: "sha512-Zml4dHVyZQ==" } } } };
test("installs exact locked graphs without scripts, atomically reuses the cache and rejects changed installed bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "ebo-runtime-test-"));
  try {
    const commands: string[][] = [];
    const run = async (_command: string, args: readonly string[], cwd: string) => {
      commands.push([...args]);
      if (args[0] === "ci") await writeFile(join(cwd, "installed.js"), "export const fixture = 1;\n");
      return { stdout: "{}", stderr: "", code: 0 };
    };
    const [first, second] = await Promise.all([installRuntime(plan, { cacheRoot: root, run }), installRuntime(plan, { cacheRoot: root, run })]);
    assert.equal(first.root, second.root);
    const ci = commands.filter((args) => args[0] === "ci");
    assert.equal(ci.length, 1);
    assert.ok(ci[0]!.includes("--ignore-scripts"));
    assert.equal(commands.some((args) => args.includes("latest")), false);
    assert.deepEqual(JSON.parse(await readFile(join(first.root, "package-lock.json"), "utf8")), plan.packageLock);
    await verifyInstalledRuntime(first.root, plan);
    await writeFile(join(first.root, "installed.js"), "tampered");
    await assert.rejects(verifyInstalledRuntime(first.root, plan), /RUNTIME_CACHE_INTEGRITY/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("rejects corrupted vendor downloads before extraction or executable probing", async () => {
  const root = await mkdtemp(join(tmpdir(), "ebo-vendor-test-")); let ran = false;
  try {
    await assert.rejects(installRuntime({ kind: "binary", platform: "darwin-arm64", abi: "native", recipe: "ebo-binary/v1", artifact: {
      locator: "https://static.devin.ai/cli/frozen.tar.gz", filename: "devin.tar.gz", integrity: `sha256-${Buffer.alloc(32).toString("base64")}` }, archive: "tar.gz" },
    { cacheRoot: root, fetch: async () => new Response("corrupt"), run: async () => { ran = true; return { code: 0, stdout: "", stderr: "" }; } }), /RUNTIME_INTEGRITY_MISMATCH/);
    assert.equal(ran, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

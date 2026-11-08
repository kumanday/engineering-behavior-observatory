import { fakeSdkRuntimeOptions } from "./runtime-fixture-helper.js";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freezeStudyRuntimes } from "../src/study-runtimes.js";
import { withStudyRuntime, currentStudyRuntime } from "../src/runtime-context.js";


const roles = ["claude-agent-sdk", "cursor-sdk", "pi-sdk", "factory-droid", "deepseek-harness"];
test("loads five SDK families from frozen installs and isolates concurrent studies", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ebo-sdk-studies-"));
  try {
    const a = join(directory, "a"), b = join(directory, "b"), aOptions = fakeSdkRuntimeOptions("9.9.9"), bOptions = fakeSdkRuntimeOptions("10.0.0");
    await freezeStudyRuntimes(a, { studyId: "a", roles }, aOptions);
    await freezeStudyRuntimes(b, { studyId: "b", roles }, bOptions);
    for (const role of roles) {
      const versions = await Promise.all([[a, aOptions], [b, bOptions]].map(async ([root, options]) => withStudyRuntime({ studyRoot: root as string, role, options: options as typeof aOptions }, async () => {
        const current = currentStudyRuntime()!;
        await new Promise((resolve) => setTimeout(resolve, 5));
        assert.equal(currentStudyRuntime(), current);
        assert.ok(current.launch.warnings.some((warning) => warning.startsWith("HARNESS_VERSION_UNVERIFIED:")));
        const { createRunBundleAssembler } = await import("../src/run-bundles.js");
        const fixture = JSON.parse(await readFile(join(process.cwd(), "test/fixtures/run-bundles/complete/manifest.json"), "utf8"));
        fixture.run.harness.id = role;
        delete fixture.run.native;
        const assembler = await createRunBundleAssembler({ ...fixture, bundleRoot: join(root as string, "bundles", role) });
        const manifest = assembler.currentManifest();
        assert.equal(manifest.schemaVersion, "run-manifest/v2");
        assert.equal(manifest.runtimeLock?.lockDigest, current.launch.lockDigest);
        assert.equal(manifest.run.harness.version, role === "factory-droid" ? "8.8.8" : [...current.modules.values()][0]!.VERSION);
        assert.equal(manifest.evidence.filter((e) => e.id.startsWith("runtime-")).length, 2);
        const { validateRunManifestEvidence } = await import("../src/artifacts.js");
        const tampered = structuredClone(manifest);
        tampered.runtimeLock!.lockDigest = `sha256:${"0".repeat(64)}`;
        assert.ok(validateRunManifestEvidence("manifest.json", tampered, assembler.bundleRoot).some((error) => error.field.startsWith("/runtimeLock")));
        return [...current.modules.values()][0]!.VERSION;
      })));
      assert.deepEqual(versions, ["9.9.9", "10.0.0"]);
    }
    assert.equal(currentStudyRuntime(), undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("an incompatible installed SDK reports the missing API contract without a version allowlist", async () => {
  const root = await mkdtemp(join(tmpdir(), "ebo-broken-sdk-")), options = fakeSdkRuntimeOptions("77.0.0");
  const original = options.run;
  options.run = async (command, args, cwd) => {
    const result = await original(command, args, cwd);
    if (args[0] === "ci") {
      const entry = join(cwd, "node_modules", "@anthropic-ai/claude-agent-sdk", "index.js");
      await writeFile(entry, (await readFile(entry, "utf8")).replace("export function query(){}", "export const query='not-a-function';"));
    }
    return result;
  };
  try {
    await freezeStudyRuntimes(root, { studyId: "broken-contract", roles: ["claude-agent-sdk"] }, options);
    await assert.rejects(withStudyRuntime({ studyRoot: root, role: "claude-agent-sdk", options }, async () => assert.fail("Must not launch an incompatible SDK")), /RUNTIME_SDK_CONTRACT_FAILED.*query/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

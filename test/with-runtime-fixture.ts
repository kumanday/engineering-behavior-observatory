import nodeTest, { after, type TestContext } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { freezeStudyRuntimes, type StudyRuntimeOptions } from "../src/study-runtimes.js";
import { currentStudyRuntime, withStudyRuntime } from "../src/runtime-context.js";
import { fakeSdkRuntimeOptions } from "./runtime-fixture-helper.js";

const fixtures = new Map<string, Promise<{ studyRoot: string; options: StudyRuntimeOptions }>>();
export async function createConformanceRuntimeFixture(role: string, deprecatedDependency = false): Promise<{ studyRoot: string; options: StudyRuntimeOptions }> {
  if (role !== "claude-agent-sdk") throw new Error(`No authored runtime fixture for ${role}.`);
  const name = "@anthropic-ai/claude-agent-sdk", entry = createRequire(import.meta.url).resolve(name);
  const metadata = JSON.parse(await readFile(join(dirname(entry), "package.json"), "utf8"));
  const studyRoot = await mkdtemp(join(tmpdir(), "ebo-conformance-runtime-")), options = fakeSdkRuntimeOptions(metadata.version, deprecatedDependency), run = options.run;
  options.run = async (command, args, cwd) => {
    const result = await run(command, args, cwd);
    if (args[0] === "ci") {
      const root = join(cwd, "node_modules", name);
      await writeFile(join(root, "package.json"), JSON.stringify({ name, version: metadata.version, claudeCodeVersion: metadata.claudeCodeVersion, type: "module", exports: { ".": "./index.js" } }));
      // The authored registry payload delegates to the installed conformance SDK.
      // The production installer is replaced only at its external command boundary.
      await writeFile(join(root, "index.js"), `export * from ${JSON.stringify(pathToFileURL(entry).href)};\n`);
    }
    return result;
  };
  await freezeStudyRuntimes(studyRoot, { studyId: `conformance-${role}`, roles: [role] }, options);
  return { studyRoot, options };
}
export async function withRuntimeFixture<T>(role: string, callback: () => Promise<T>): Promise<T> {
  if (currentStudyRuntime()?.launch.role === role) return callback();
  if (!fixtures.has(role)) fixtures.set(role, createConformanceRuntimeFixture(role));
  const binding = await fixtures.get(role)!;
  return withStudyRuntime({ ...binding, role }, callback);
}
/** Supplies a real study boundary to fake-turn protocol tests. No production bypass. */
export function runtimeTest(role: string): typeof nodeTest {
  const wrap = (implementation: typeof nodeTest.skip): typeof nodeTest => ((name: string, optionsOrCallback: any, callback?: (context: TestContext) => Promise<unknown>) => {
    const options = typeof optionsOrCallback === "function" ? {} : optionsOrCallback ?? {};
    const body = typeof optionsOrCallback === "function" ? optionsOrCallback : callback;
    return implementation(name, options, async (context) => withRuntimeFixture(role, async () => body?.(context)));
  }) as typeof nodeTest;
  const wrapped = wrap(nodeTest);
  Object.assign(wrapped, { skip: wrap(nodeTest.skip), only: wrap(nodeTest.only), todo: wrap(nodeTest.todo) });
  return wrapped;
}
after(async () => { for (const pending of fixtures.values()) { const result = await pending.catch(() => undefined); if (result) await rm(result.studyRoot, { recursive: true, force: true }); } });

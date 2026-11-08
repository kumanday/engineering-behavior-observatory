import { fakeOciRuntimeOptions } from "./runtime-oci-fixture.js";
import { fakeVendorRuntimeOptions } from "./runtime-vendor-fixture.js";
import nodeTest, { after, type TestContext } from "node:test";
import { cp, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { freezeStudyRuntimes, type StudyRuntimeOptions } from "../src/study-runtimes.js";
import { currentStudyRuntime, withStudyRuntime } from "../src/runtime-context.js";
import { fakeSdkRuntimeOptions } from "./runtime-fixture-helper.js";

const fixtures = new Map<string, Promise<{ studyRoot: string; options: StudyRuntimeOptions }>>();
export async function createConformanceRuntimeFixture(role: string, deprecatedDependency = false, cliFallback?: string): Promise<{ studyRoot: string; options: StudyRuntimeOptions }> {
  if (role === "openhands-agent-server") {
    const studyRoot = await mkdtemp(join(tmpdir(), "ebo-openhands-runtime-")), options = fakeOciRuntimeOptions();
    await freezeStudyRuntimes(studyRoot, {studyId: "conformance-openhands", roles: [role]}, options);
    return {studyRoot, options};
  }
  if (role === "devin-cli") {
    const studyRoot = await mkdtemp(join(tmpdir(), "ebo-devin-runtime-")), options = fakeVendorRuntimeOptions(cliFallback);
    await freezeStudyRuntimes(studyRoot, {studyId: "conformance-devin", roles: [role]}, options);
    return {studyRoot, options};
  }
  if (role === "codex-app-server" || role === "codex-judge") return createCodexFixture(role, cliFallback);
  if (!["claude-agent-sdk", "cursor-sdk", "pi-sdk", "factory-droid", "deepseek-harness"].includes(role)) throw new Error(`No authored runtime fixture for ${role}.`);
  const name = role === "cursor-sdk" ? "@cursor/sdk" : role === "pi-sdk" ? "@earendil-works/pi-coding-agent" : role === "factory-droid" ? "@factory/droid-sdk" : role === "deepseek-harness" ? "@deepseek-ai/dsh-sdk-client" : "@anthropic-ai/claude-agent-sdk", entry = fileURLToPath(import.meta.resolve(name));
  let packageRoot = dirname(entry), metadata: any;
  for (;;) {
    try { metadata = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")); if (metadata.name === name) break; } catch {}
    if (dirname(packageRoot) === packageRoot) throw new Error(`No package metadata for ${name}.`);
    packageRoot = dirname(packageRoot);
  }
  const studyRoot = await mkdtemp(join(tmpdir(), "ebo-conformance-runtime-")), options = fakeSdkRuntimeOptions(role === "factory-droid" ? { "@factory/droid-sdk": metadata.version, "@factory/cli": "0.238.0" } : metadata.version, deprecatedDependency), run = options.run;
  options.run = async (command, args, cwd) => {
    const result = await run(command, args, cwd);
    if (args[0] === "ci") {
      const root = join(cwd, "node_modules", name);
      await writeFile(join(root, "package.json"), JSON.stringify({ name, version: metadata.version, claudeCodeVersion: metadata.claudeCodeVersion, type: "module", exports: { ".": "./index.js", ...(role === "factory-droid" ? { "./node": "./node.js" } : {}) } }));
      // The authored registry payload delegates to the installed conformance SDK.
      // The production installer is replaced only at its external command boundary.
      await writeFile(join(root, "index.js"), `export * from ${JSON.stringify(pathToFileURL(entry).href)};\n`);
      if (role === "deepseek-harness") {
        const protocol = join(cwd, "node_modules", "@deepseek-ai/dsh-sdk-protocol");
        await writeFile(join(protocol, "index.js"), `export * from ${JSON.stringify(import.meta.resolve("@deepseek-ai/dsh-sdk-protocol"))};\n`);
        const bin = join(cwd, "node_modules", ".bin"); await mkdir(bin, {recursive: true});
        await writeFile(join(bin, "dsh"), `#!${process.execPath}\n` + await readFile(fileURLToPath(new URL("../../test/fixtures/deepseek/fake-runtime.mjs", import.meta.url)), "utf8"));
        await chmod(join(bin, "dsh"), 0o700);
      }
      if (role === "factory-droid") {
        await writeFile(join(root, "node.js"), `export * from ${JSON.stringify(import.meta.resolve("@factory/droid-sdk/node"))};\n`);
        const bin = join(cwd, "node_modules", ".bin"); await mkdir(bin, { recursive: true });
        const executable = join(bin, "droid"), fallback = fileURLToPath(new URL("../../test/fixtures/factory/fake-droid.mjs", import.meta.url));
        await writeFile(executable, `#!${process.execPath}\nimport {pathToFileURL} from 'node:url';\nconst args=process.argv.slice(2);if(args.includes('--version')){console.log('0.238.0');process.exit(0);}const file=args[0]?.endsWith('.mjs')?args.shift():${JSON.stringify(fallback)};process.argv=[process.execPath,file,...args];await import(pathToFileURL(file).href);\n`);
        await chmod(executable, 0o700);
      }
    }
    return result;
  };
  await freezeStudyRuntimes(studyRoot, { studyId: `conformance-${role}`, roles: [role], ...(role === "deepseek-harness" ? {harnessPolicies: {[role]: {allowPrerelease: true}}} : {}) }, options);
  return { studyRoot, options };
}
async function createCodexFixture(role: string, fallback?: string): Promise<{studyRoot: string; options: StudyRuntimeOptions}> {
  const version = "0.162.1", options = fakeSdkRuntimeOptions(version), run = options.run;
  const studyRoot = await mkdtemp(join(tmpdir(), "ebo-codex-runtime-"));
  options.run = async (command, args, cwd) => {
    const result = await run(command, args, cwd);
    if (args[0] === "ci") {
      const bin = join(cwd, "node_modules", ".bin"); await mkdir(bin, { recursive: true });
      const executable = join(bin, "codex"), file = fallback ?? fileURLToPath(new URL(role === "codex-judge" ? "../../test/fixtures/codex/fake-judge.mjs" : "../../test/fixtures/codex/fake-app-server.mjs", import.meta.url));
      await writeFile(executable, `#!${process.execPath}\nimport {pathToFileURL} from 'node:url';\nconst args=process.argv.slice(2);if(args.includes('--version')){console.log('codex-cli ${version}');process.exit(0);}const file=args[0]?.endsWith('.mjs')?args.shift():${JSON.stringify(file)};process.argv=[process.execPath,file,...args];await import(pathToFileURL(file).href);\n`);
      await chmod(executable, 0o700);
    }
    return result;
  };
  await freezeStudyRuntimes(studyRoot, {studyId: `conformance-${role}`, roles: [role]}, options);
  return {studyRoot, options};
}
/** Child CLI tests mock registry/OSV I/O through Node's ordinary module preload. */
export async function prepareRuntimeCliFixture(studyRoot: string, role: string, cliFallback?: string): Promise<string> {
  await mkdir(studyRoot, {recursive: true});
  const binding = await createConformanceRuntimeFixture(role, false, cliFallback);
  try { await cp(join(binding.studyRoot, "runtimes"), join(studyRoot, "runtimes"), {recursive: true, force: false, errorOnExist: true}); }
  finally { await rm(binding.studyRoot, {recursive: true, force: true}); }
  const preload = join(studyRoot, "runtime-network-fixture.mjs");
  await writeFile(preload, `import {fakeSdkRuntimeOptions} from ${JSON.stringify(new URL("./runtime-fixture-helper.js", import.meta.url).href)};
import {fakeVendorRuntimeOptions} from ${JSON.stringify(new URL("./runtime-vendor-fixture.js", import.meta.url).href)};
const network=${role === "devin-cli" ? `fakeVendorRuntimeOptions()` : `fakeSdkRuntimeOptions('0.162.1')`};
globalThis.fetch=async(url,init)=>String(url).startsWith('https://api.osv.dev/')?new Response(JSON.stringify(String(url).endsWith('querybatch')?{results:JSON.parse(init.body).queries.map(()=>({}))}:{})):network.fetch(String(url));
`);
  return preload;
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

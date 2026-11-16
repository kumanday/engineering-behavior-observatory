import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const fakeSdkRuntimeOptions = (version: string | Record<string, string>, deprecatedDependency = false) => ({ now: () => "2026-11-07T12:00:00Z", query: async () => ({}), fetch: async (url: string) => {
  const name = decodeURIComponent(new URL(url).pathname.slice(1).split("/")[0]!);
  const selectedVersion = name === "fixture-deprecated-dependency" ? "2.0.0" : typeof version === "object" ? version[name]! : name === "@factory/cli" ? "8.8.8" : version;
  return new Response(JSON.stringify({ time: { [selectedVersion]: "2026-11-05T00:00:00Z" }, versions: { [selectedVersion]: { ...(name === "fixture-deprecated-dependency" ? { deprecated: "Use the platform API" } : deprecatedDependency ? { dependencies: { "fixture-deprecated-dependency": "2.0.0" } } : {}), dist: { tarball: `https://registry.npmjs.org/${encodeURIComponent(name)}.tgz`, integrity: "sha512-Zml4dHVyZQ==" } } } }));
}, run: async (_cmd: string, args: readonly string[], cwd: string) => {
  const pkg = JSON.parse(await readFile(join(cwd, "package.json"), "utf8"));
  const graph: Record<string, string> = Object.fromEntries(Object.entries(pkg.dependencies).map(([name, declared]) => [name, String(declared).startsWith("https:") ? typeof version === "object" ? version[name]! : name === "@factory/cli" ? "8.8.8" : version : String(declared)]));
  if (deprecatedDependency) graph["fixture-deprecated-dependency"] = "2.0.0";
  if (args.includes("--package-lock-only")) await writeFile(join(cwd, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "": { dependencies: pkg.dependencies }, ...Object.fromEntries(Object.entries(graph as Record<string, string>).map(([name, version]) => [`node_modules/${name}`, { version, resolved: `https://registry.npmjs.org/${encodeURIComponent(name)}.tgz`, integrity: "sha512-Zml4dHVyZQ==" }])) } }));
  if (args[0] === "ci") for (const name of Object.keys(graph)) {
    const root = join(cwd, "node_modules", name); await mkdir(root, { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({ name, version: graph[name], claudeCodeVersion: graph[name], type: "module", exports: { ".": "./index.js", "./node": "./index.js" } }));
    await writeFile(join(root, "index.js"), `export const VERSION=${JSON.stringify(graph[name])}; export const HOOK_EVENTS=[]; export function query(){};export const Agent={create(){}};export const Cursor={configure(){}};export class JsonlLocalAgentStore{};export const JSONL_LOCAL_AGENT_STORE_FILES={};export function createAgentSession(){};export function createBashToolDefinition(){};export class DefaultResourceLoader{};export const ModelRuntime={create(){}};export const SessionManager={create(){}};export const SettingsManager={inMemory(){}};export function createSession(){};export class HarnessClient{};export const SessionNotificationSchema={parse(){}};export const FACTORY_PROTOCOL_VERSION="fixture";`);
  }
  return { code: 0, stdout: "{}", stderr: "" };
} });

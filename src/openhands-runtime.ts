import {AsyncLocalStorage} from "node:async_hooks";
import {stat} from "node:fs/promises";
import {isAbsolute, join} from "node:path";
import {currentStudyRuntime, recordRuntimeExecution, withStudyRuntime, lockedRuntimePython} from "./runtime-context.js";
import {RuntimePolicyError} from "./runtime-resolution.js";
import {readStudyRuntimeLock} from "./study-runtimes.js";
import {currentOpenHandsSmolGuest, startOpenHandsInSmolGuest} from "./openhands-smol-guest.js";
import {startOpenHandsSmol, type OpenHandsSmolServer} from "./openhands-smol.js";

type Server = Pick<OpenHandsSmolServer, "baseUrl" | "stop" | "isStopped">;
const servers = new AsyncLocalStorage<Server>();

/** Bind the REST endpoint to an owned local Smol VM and an immutable OCI image. */
export async function withLockedOpenHandsServer<T>(request: {sessionApiKey?: string; workspacePath?: string; serverWorkspacePath?: string; signal?: AbortSignal; onStarting?: (stop: () => Promise<void>) => void; shutdownGraceMs?: number}, callback: (server: Server) => Promise<T>): Promise<T> {
  request.signal?.throwIfAborted();
  const active = servers.getStore(); if (active) return callback(active);
  const context = currentStudyRuntime();
  if (!context || context.launch.role !== "openhands-agent-server") throw new RuntimePolicyError("RUNTIME_STUDY_LOCK_REQUIRED", "OpenHands needs its frozen study runtime.");
  const lock = await readStudyRuntimeLock(context.studyRoot), group = lock.groups.find(group => group.roles.includes(context.launch.role)), plan = group?.plan;
  if (plan?.kind !== "oci") throw new RuntimePolicyError("RUNTIME_RECIPE_INVALID", "OpenHands requires a frozen image.");
  const injected = context.options.startOpenHandsSmol;
  const guest = currentOpenHandsSmolGuest();
  const engine = lock.groups.find(group => group.roles.includes("smol"));
  if (!injected && (!engine || !group!.executionEnvironment)) throw new RuntimePolicyError("RUNTIME_SMOL_NOT_FROZEN", "Freeze OpenHands and the local Smol role in the same study before launching a server.");
  let python = "", engineVersion = "authored-fixture", engineReceipt: string | undefined;
  if (!injected && guest) {
    engineVersion = engine!.roots.find(root => root.name === "smolmachines")!.selection.release.version;
    const {readFile} = await import("node:fs/promises");
    const {digestMetadata} = await import("./artifacts.js");
    const receipt = JSON.parse(await readFile(join(context.studyRoot, "runtimes/cache", engine!.installation.key, ".ebo-runtime-receipt.json"), "utf8"));
    const library = receipt.inventory.find((entry: {path: string}) => /\/smol\/libkrun\.(?:dylib|so)$/u.test(entry.path));
    if (`sha256:${digestMetadata(receipt).value}` !== engine!.installation.receiptDigest || library?.digest !== guest.libkrunSha256) throw new RuntimePolicyError("RUNTIME_INTEGRITY_MISMATCH", "The task VM's Smol library differs from the study engine.");
  }
  if (!injected && !guest) await withStudyRuntime({studyRoot: context.studyRoot, role: "smol", options: context.options}, async () => {
    python = lockedRuntimePython();
    engineVersion = currentStudyRuntime()!.launch.roots.find(root => root.name === "smolmachines")!.selection.release.version;
    engineReceipt = currentStudyRuntime()!.launch.receiptLocator;
  });
  let workspaceUser: string | undefined;
  const serverWorkspacePath = request.serverWorkspacePath ?? request.workspacePath;
  if (request.workspacePath) {
    if (!isAbsolute(request.workspacePath) || !serverWorkspacePath || !isAbsolute(serverWorkspacePath)) throw new RuntimePolicyError("RUNTIME_WORKSPACE_INVALID", "OpenHands workspace mounts require absolute paths.");
    const owner = await stat(request.workspacePath); workspaceUser = `${owner.uid}:${owner.gid}`;
  }
  if (request.sessionApiKey && /[\r\n]/u.test(request.sessionApiKey)) throw new RuntimePolicyError("RUNTIME_SERVER_AUTH_INVALID", "Session API keys must be single-line values.");
  const config = (group!.roots[0]!.selection.release.metadata?.config as any)?.config;
  if (!config || !Array.isArray(config.Entrypoint) || !config.Entrypoint.length || config.Entrypoint.some((arg: unknown) => typeof arg !== "string" || !arg)
      || config.Env !== undefined && (!Array.isArray(config.Env) || config.Env.some((value: unknown) => typeof value !== "string" || !value.includes("=")))) throw new RuntimePolicyError("RUNTIME_RECIPE_INVALID", "The frozen OpenHands image must declare its server entrypoint and environment.");
  const start = injected ?? (guest ? (request: import("./openhands-smol.js").OpenHandsSmolRequest) => startOpenHandsInSmolGuest(request, guest) : startOpenHandsSmol);
  const server = await start({python, cwd: join(context.studyRoot, "runtimes"), image: plan.image, configDigest: plan.configDigest, platform: plan.platform,
    command: [...config.Entrypoint, "--host", "0.0.0.0", "--port", "8000"], imageEnvironment: Object.fromEntries((config.Env ?? []).map((entry: string) => {const at = entry.indexOf("="); return [entry.slice(0, at), entry.slice(at + 1)];})),
    workdir: config.WorkingDir || "/", workspacePath: request.workspacePath, serverWorkspacePath, workspaceUser, sessionApiKey: request.sessionApiKey, engineVersion, signal: request.signal, onStarting: request.onStarting, shutdownGraceMs: request.shutdownGraceMs});
  try {
    const endpoint = new URL(server.baseUrl);
    await recordRuntimeExecution({...server.binding, expectedImage: plan.image, expectedConfigDigest: plan.configDigest, workspaceUser: workspaceUser ?? null, ...(engineReceipt ? {engineReceipt} : {})});
    if (server.binding.image !== plan.image || server.binding.imageConfigDigest !== plan.configDigest || server.binding.platform !== plan.platform) throw new RuntimePolicyError("RUNTIME_INTEGRITY_MISMATCH", "The actual Smol image differs from the frozen platform manifest.");
    if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || !endpoint.port || endpoint.username || endpoint.password) throw new RuntimePolicyError("RUNTIME_CONTAINER_BINDING_INVALID", "The owned OpenHands server must have a loopback endpoint.");
    return await servers.run(server, () => callback(server));
  } finally {await server.stop(); await recordRuntimeExecution({...server.binding, state: "stopped", terminationConfirmed: server.isStopped()});}
}

import { AsyncLocalStorage } from "node:async_hooks";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { currentStudyRuntime, recordRuntimeExecution } from "./runtime-context.js";
import { runRuntimeCommand } from "./runtime-installation.js";
import { RuntimePolicyError } from "./runtime-resolution.js";
import { readStudyRuntimeLock } from "./study-runtimes.js";

type Server = {baseUrl: string; stop: () => Promise<void>};
const servers = new AsyncLocalStorage<Server>();

/** Bind the protocol endpoint to a container launched from the study's immutable image. */
export async function withLockedOpenHandsServer<T>(request: {sessionApiKey?: string; workspacePath?: string; serverWorkspacePath?: string}, callback: (server: Server) => Promise<T>): Promise<T> {
  const active = servers.getStore(); if (active) return callback(active);
  const context = currentStudyRuntime();
  if (!context || context.launch.role !== "openhands-agent-server") throw new RuntimePolicyError("RUNTIME_STUDY_LOCK_REQUIRED", "OpenHands needs its frozen study runtime.");
  const lock = await readStudyRuntimeLock(context.studyRoot), plan = lock.groups.find((group) => group.roles.includes(context.launch.role))?.plan;
  if (plan?.kind !== "oci") throw new RuntimePolicyError("RUNTIME_RECIPE_INVALID", "OpenHands requires a frozen image.");
  const run = context.options.run ?? runRuntimeCommand;
  const command = async (args: string[]): Promise<string> => {
    const result = await run("docker", args, context.launch.runtimeRoot);
    if (result.code !== 0) throw new RuntimePolicyError("RUNTIME_CONTAINER_FAILED", `docker ${args[0]}: ${result.stderr.slice(0, 2000)}`);
    return result.stdout;
  };
  const args = ["run", "--detach", "--platform", plan.platform.replace(/-/, "/"), "--publish", "127.0.0.1::8000"];
  if (request.workspacePath) {
    const target = request.serverWorkspacePath ?? request.workspacePath;
    if (!isAbsolute(request.workspacePath) || !isAbsolute(target) || request.workspacePath.includes(",") || target.includes(",")) throw new RuntimePolicyError("RUNTIME_WORKSPACE_INVALID", "OpenHands workspace mounts require absolute paths without commas.");
    args.push("--mount", `type=bind,source=${request.workspacePath},target=${target}`);
  }
  const temporary = await mkdtemp(join(tmpdir(), "ebo-openhands-server-"));
  let containerId: string;
  try {
    if (request.sessionApiKey) {
      if (/[\r\n]/u.test(request.sessionApiKey)) throw new RuntimePolicyError("RUNTIME_SERVER_AUTH_INVALID", "Session API keys must be single-line values.");
      const envFile = join(temporary, "server.env"); await writeFile(envFile, `SESSION_API_KEY=${request.sessionApiKey}\n`, {mode: 0o600});
      args.push("--env-file", envFile);
    }
    args.push(plan.image, "--host", "0.0.0.0", "--port", "8000");
    containerId = (await command(args)).trim();
  } finally {await rm(temporary, {recursive: true, force: true});}
  if (!/^[a-f0-9]{12,64}$/u.test(containerId)) throw new RuntimePolicyError("RUNTIME_PROBE_INVALID", "Docker did not return a container ID.");
  let stopped = false;
  const stop = async (): Promise<void> => { if (!stopped) {stopped = true; await command(["rm", "--force", containerId]);} };
  try {
    let actual: any; try {actual = JSON.parse(await command(["container", "inspect", containerId]))[0];} catch (error) {if (error instanceof RuntimePolicyError) throw error; throw new RuntimePolicyError("RUNTIME_PROBE_INVALID", "Docker container inspect returned malformed JSON.");}
    const binding = {componentId: "openhands", kind: "docker-container", containerId, expectedImage: plan.image, expectedConfigDigest: plan.configDigest,
      actualConfigDigest: actual?.Image ?? null, actualImage: actual?.Config?.Image ?? null};
    await recordRuntimeExecution(binding);
    if (actual?.Image !== plan.configDigest || actual?.Config?.Image !== plan.image) throw new RuntimePolicyError("RUNTIME_INTEGRITY_MISMATCH", "The actual OpenHands container differs from the study's frozen image.");
    const ports = actual.NetworkSettings?.Ports?.["8000/tcp"];
    if (actual.State?.Running !== true || !Array.isArray(ports) || ports.length !== 1 || ports[0]?.HostIp !== "127.0.0.1" || !/^\d+$/u.test(ports[0]?.HostPort ?? "")) throw new RuntimePolicyError("RUNTIME_CONTAINER_BINDING_INVALID", "OpenHands requires a running container with one loopback server port.");
    const server = {baseUrl: `http://127.0.0.1:${ports[0].HostPort}`, stop};
    await recordRuntimeExecution({...binding, baseUrl: server.baseUrl});
    return await servers.run(server, async () => callback(server));
  } finally {await stop();}
}

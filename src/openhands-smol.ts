import {spawn} from "node:child_process";
import {createInterface} from "node:readline";
import {RuntimePolicyError} from "./runtime-resolution.js";

export type OpenHandsSmolRequest = {python: string; cwd: string; image: string; configDigest: string; platform: string; command: string[]; imageEnvironment: Record<string, string>; workdir?: string;
  workspacePath?: string; serverWorkspacePath?: string; workspaceUser?: string; sessionApiKey?: string; engineVersion: string; signal?: AbortSignal; onStarting?: (stop: () => Promise<void>) => void; shutdownGraceMs?: number};
export type OpenHandsSmolServer = {baseUrl: string; binding: Record<string, unknown>; stop: () => Promise<void>; isStopped: () => boolean};
export type OpenHandsSmolStarter = (request: OpenHandsSmolRequest) => Promise<OpenHandsSmolServer>;

/** Owned local provider glue. The harness protocol remains REST/WebSocket. */
export const OPENHANDS_SMOL_SCRIPT = String.raw`
import importlib.metadata, json, os, signal, sys, uuid

def terminate(signum, frame):
    raise SystemExit(128 + signum)
signal.signal(signal.SIGTERM, terminate)
from smol import Machine, MachineConfig, ConnectOptions, MountSpec, ResourceSpec

def emit(value):
    print('EBO_OPENHANDS_SMOL ' + json.dumps(value), flush=True)

request = json.loads(sys.stdin.readline())
if importlib.metadata.version('smolmachines') != request['engineVersion']:
    raise ValueError('RUNTIME_PROBE_MISMATCH: smolmachines')
machine = None
try:
    mounts = []
    if request.get('workspacePath'):
        mounts.append(MountSpec(source=request['workspacePath'], target=request['serverWorkspacePath'], read_only=False))
    env = dict(request['imageEnvironment'])
    if request.get('workspaceUser'): env['HOME'] = '/tmp'
    if request.get('sessionApiKey'): env['SESSION_API_KEY'] = request['sessionApiKey']
    machine = Machine.create(MachineConfig(
        name='ebo-openhands-' + uuid.uuid4().hex,
        image=request['image'], command=request['command'], env=env,
        user=request.get('workspaceUser'), workdir=request.get('workdir') or '/',
        mounts=mounts, wait_for_ports=False,
        resources=ResourceSpec(cpus=2, memory_mb=4096, storage_gb=16, network=True),
        persistent=False, detach=False, ready_timeout_seconds=240,
    ), ConnectOptions(target='local'))
    machine.publish(8000)
    machine.wait_until_ready(timeout_s=120)
    image = machine.pull_image(request['image'])
    if image.reference != request['image'] or image.digest != request['configDigest'] or image.os + '-' + image.architecture != request['platform']:
        raise ValueError('RUNTIME_INTEGRITY_MISMATCH: Smol image differs from frozen platform manifest')
    boot = machine.exec(['cat', '/proc/sys/kernel/random/boot_id'])
    if boot.exit_code or not boot.stdout.strip(): raise ValueError('Cannot read owned VM boot identity')
    endpoint = machine.endpoint(8000)
    emit({'state': 'ready', 'machine': machine.name, 'bootId': boot.stdout.strip(),
          'image': image.reference, 'imageConfigDigest': image.digest, 'platform': request['platform'],
          'engineVersion': importlib.metadata.version('smolmachines'), 'baseUrl': endpoint.http_url})
    # EOF is the sole shutdown instruction. No model, tool or generic RPC data
    # passes through this pipe.
    sys.stdin.read()
finally:
    if machine is not None:
        try: machine.stop(timeout_secs=5)
        finally: machine.delete()
        emit({'state': 'stopped', 'machine': machine.name})
`;

export const startOpenHandsSmol: OpenHandsSmolStarter = async (request) => {
  request.signal?.throwIfAborted();
  const {signal, onStarting, shutdownGraceMs = 5000, ...wireRequest} = request;
  const child = spawn(request.python, ["-I", "-B", "-c", OPENHANDS_SMOL_SCRIPT], {cwd: request.cwd,
    env: {PATH: process.env.PATH, HOME: process.env.HOME, LANG: "C.UTF-8", PYTHONDONTWRITEBYTECODE: "1", ...(process.env.SSL_CERT_FILE ? {SSL_CERT_FILE: process.env.SSL_CERT_FILE} : {})}, stdio: ["pipe", "pipe", "pipe"]});
  const lines = createInterface({input: child.stdout});
  let stopped = false, readyReceived = false, stderr = "", stopPromise: Promise<void> | undefined;
  child.stderr.on("data", bytes => {stderr = (stderr + String(bytes)).slice(-8192);});
  const exited = new Promise<{code: number | null; signal: string | null}>((resolve, reject) => {
    child.once("error", reject); child.once("close", (code, signal) => resolve({code, signal}));
  });
  // Install rejection handling before writing; a failed interpreter can exit immediately.
  void exited.catch(() => {});
  const ready = new Promise<Record<string, any>>((resolve, reject) => {
    lines.on("line", line => {
      if (!line.startsWith("EBO_OPENHANDS_SMOL ")) return;
      try {const value = JSON.parse(line.slice("EBO_OPENHANDS_SMOL ".length)); if (value.state === "ready") {readyReceived = true; resolve(value);} else if (value.state === "stopped") stopped = true;}
      catch {reject(new RuntimePolicyError("RUNTIME_PROBE_INVALID", "Smol returned malformed ownership metadata."));}
    });
    void exited.then(() => reject(new RuntimePolicyError("RUNTIME_SMOL_FAILED", "Owned OpenHands VM exited before readiness.")), reject);
  });
  child.stdin.on("error", () => {});
  const stop = (): Promise<void> => stopPromise ??= (async () => {
    child.stdin.end();
    if (!readyReceived) child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), shutdownGraceMs); timer.unref();
    try {const result = await exited; if (result.code !== 0 || !stopped) throw new RuntimePolicyError("RUNTIME_SMOL_CLEANUP_FAILED", "Smol did not confirm deletion of the owned VM.");}
    finally {clearTimeout(timer); lines.close();}
  })();
  const abort = () => {void stop().catch(() => {});};
  onStarting?.(stop);
  signal?.addEventListener("abort", abort, {once: true});
  if (signal?.aborted) abort();
  else child.stdin.write(JSON.stringify(wireRequest) + "\n");
  const timer = setTimeout(abort, 300_000); timer.unref();
  try {
    const binding = await ready;
    signal?.throwIfAborted();
    const url = new URL(binding.baseUrl);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password
        || binding.image !== request.image || binding.imageConfigDigest !== request.configDigest || binding.platform !== request.platform || binding.engineVersion !== request.engineVersion
        || typeof binding.machine !== "string" || !binding.machine.startsWith("ebo-openhands-") || !/^[a-f0-9-]{36}$/u.test(binding.bootId ?? "")) throw new RuntimePolicyError("RUNTIME_CONTAINER_BINDING_INVALID", "Smol ownership, image or loopback endpoint differs from the frozen request.");
    return {baseUrl: url.origin, binding: {...binding, kind: "smol-local-vm", target: "local"}, stop, isStopped: () => stopped};
  } catch (error) {
    await stop().catch(() => {});
    const detail = request.sessionApiKey ? stderr.replaceAll(request.sessionApiKey, "[redacted]") : stderr;
    throw new RuntimePolicyError("RUNTIME_SMOL_FAILED", `${error instanceof Error ? error.message : String(error)}${detail ? `: ${detail}` : ""}`);
  } finally {clearTimeout(timer); signal?.removeEventListener("abort", abort);}
};

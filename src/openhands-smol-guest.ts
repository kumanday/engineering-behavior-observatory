import {AsyncLocalStorage} from "node:async_hooks";
import {spawn} from "node:child_process";
import {createServer} from "node:net";
import {access, mkdir, readFile, rmdir, writeFile} from "node:fs/promises";
import {randomUUID} from "node:crypto";
import {join} from "node:path";
import type {OpenHandsSmolRequest, OpenHandsSmolServer} from "./openhands-smol.js";
import {RuntimePolicyError} from "./runtime-resolution.js";

/** Supplied by the Harbor owner, alongside the worker input, before candidate execution. */
export type OwnedSmolGuest = {schemaVersion: "ebo.smol-owned-task/v1"; image: string; imageConfigDigest: string; machine: string; bootId: string; engineVersion: string; libkrunSha256: string; serverCgroupRoot?: string};
const guests = new AsyncLocalStorage<OwnedSmolGuest>();
export const currentOpenHandsSmolGuest = (): OwnedSmolGuest | undefined => guests.getStore();
export const withOwnedOpenHandsSmolGuest = <T>(binding: OwnedSmolGuest, callback: () => Promise<T>): Promise<T> => guests.run(binding, callback);

/** A Harbor worker already lives inside the owned task VM. Start only its HTTP server. */
export async function startOpenHandsInSmolGuest(request: OpenHandsSmolRequest, binding: OwnedSmolGuest): Promise<OpenHandsSmolServer> {
  request.signal?.throwIfAborted();
  if (process.platform !== "linux" || binding.schemaVersion !== "ebo.smol-owned-task/v1" || binding.image !== request.image || binding.imageConfigDigest !== request.configDigest || binding.engineVersion !== request.engineVersion
      || !/^sha256:[a-f0-9]{64}$/u.test(binding.image.split("@")[1] ?? "") || !/^[a-f0-9]{64}$/u.test(binding.libkrunSha256) || !binding.machine || !/^\/sys\/fs\/cgroup\/ebo-openhands-[a-f0-9]+$/u.test(binding.serverCgroupRoot ?? "")
      || (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim() !== binding.bootId) throw new RuntimePolicyError("RUNTIME_CONTAINER_BINDING_INVALID", "OpenHands worker does not match its owned Smol task VM.");
  const port = await new Promise<number>((resolve, reject) => {
    const socket = createServer(); socket.once("error", reject);
    socket.listen(0, "127.0.0.1", () => {const address = socket.address(); if (!address || typeof address === "string") {socket.close(); reject(new Error("No local server port.")); return;} socket.close(error => error ? reject(error) : resolve(address.port));});
  });
  request.signal?.throwIfAborted();
  const command = request.command.slice(); command[command.lastIndexOf("--host") + 1] = "127.0.0.1"; command[command.lastIndexOf("--port") + 1] = String(port);
  if (process.getuid!() !== 0) throw new RuntimePolicyError("RUNTIME_GUEST_CONTAINMENT_UNAVAILABLE", "The owned OpenHands worker needs root inside its task VM to join the server cgroup before applying the workspace uid/gid.");
  const cgroup = join(binding.serverCgroupRoot!, "server-" + randomUUID());
  await mkdir(cgroup);
  const [uid, gid] = (request.workspaceUser ?? `${process.getuid!()}:${process.getgid!()}`).split(":").map(Number);
  if (![uid, gid].every(value => Number.isSafeInteger(value) && value! >= 0)) throw new RuntimePolicyError("RUNTIME_WORKSPACE_INVALID", "Invalid server workspace uid/gid.");
  try {await access(join(cgroup, "cgroup.kill")); await access("/usr/sbin/chroot");}
  catch (error) {await rmdir(cgroup); throw new RuntimePolicyError("RUNTIME_GUEST_CONTAINMENT_UNAVAILABLE", String(error));}
  // Joining before exec makes detached tmux and setsid tool children inherit the
  // same cgroup. Process-group membership alone cannot establish quiescence.
  const child = spawn("/bin/sh", ["-eu", "-c", 'printf "%s" "$$" > "$1/cgroup.procs"; shift; exec "$@"', "ebo-owned-server", cgroup, "/usr/sbin/chroot", `--userspec=${uid}:${gid}`, `--groups=${gid}`, "/", ...command],
    {cwd: request.workdir, env: {...request.imageEnvironment, HOME: "/tmp", ...(request.sessionApiKey ? {SESSION_API_KEY: request.sessionApiKey} : {})}, detached: true, stdio: "ignore"});
  let stopped = false, stopPromise: Promise<void> | undefined;
  const exited = new Promise<void>((resolve, reject) => {child.once("error", reject); child.once("close", () => resolve());});
  void exited.catch(() => {});
  const kill = (signal: NodeJS.Signals) => {if (!child.pid) return; try {process.kill(-child.pid, signal);} catch (error) {if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;}};
  const stop = (): Promise<void> => stopPromise ??= (async () => {
    kill("SIGTERM");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([exited.catch(() => {}), new Promise<void>(resolve => {timer = setTimeout(resolve, request.shutdownGraceMs ?? 5000);})]);
      await writeFile(join(cgroup, "cgroup.kill"), "1");
      for (let i = 0; i < 100; i++) {
        if (/^populated 0$/mu.test(await readFile(join(cgroup, "cgroup.events"), "utf8"))) {stopped = true; break;}
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      if (!stopped) throw new RuntimePolicyError("RUNTIME_SMOL_CLEANUP_FAILED", "OpenHands server cgroup is still populated; workspace termination is unproven.");
      await exited.catch(() => {}); await rmdir(cgroup);
    } finally {if (timer) clearTimeout(timer); request.signal?.removeEventListener("abort", abort);}
  })();
  const abort = () => {void stop().catch(() => {});};
  request.onStarting?.(stop); request.signal?.addEventListener("abort", abort, {once: true});
  if (request.signal?.aborted) {await stop(); request.signal.throwIfAborted();}
  try {await new Promise<void>((resolve, reject) => {child.once("spawn", resolve); child.once("error", reject);});}
  catch (error) {await stop().catch(() => {}); throw error;}

  return {baseUrl: `http://127.0.0.1:${port}`, binding: {kind: "smol-guest-server", target: "local", ...binding, imageConfigDigest: binding.imageConfigDigest, platform: request.platform, serverPid: child.pid, actualUser: `${uid}:${gid}`, cgroup}, stop, isStopped: () => stopped};
}

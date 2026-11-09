import assert from "node:assert/strict";
import test from "node:test";
import {chown, mkdtemp, readFile, writeFile, rm, stat} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {startOpenHandsSmol, type OpenHandsSmolRequest} from "../src/openhands-smol.js";
import {startOpenHandsInSmolGuest} from "../src/openhands-smol-guest.js";

const request = (root: string): OpenHandsSmolRequest => ({python: join(root, "fake-python"), cwd: root, image: `ghcr.io/openhands/agent-server@sha256:${"a".repeat(64)}`, configDigest: `sha256:${"c".repeat(64)}`, platform: "linux-arm64", command: ["openhands-agent-server", "--host", "0.0.0.0", "--port", "8000"], imageEnvironment: {PATH: process.env.PATH!}, engineVersion: "1.32.4", workspacePath: root, shutdownGraceMs: 1000});

test("canceling a pending Smol startup drains its owner before workspace finalization", async () => {
  const root = await mkdtemp(join(tmpdir(), "ebo-smol-startup-abort-")), controller = new AbortController();
  let registered = false;
  try {
    await writeFile(join(root, "fake-python"), `#!${process.execPath}\nimport {createInterface} from 'node:readline';import {writeFileSync} from 'node:fs';import {join} from 'node:path';\nconst lines=createInterface({input:process.stdin});lines.once('line',line=>{const r=JSON.parse(line);writeFileSync(join(r.workspacePath,'starting'),'yes');setTimeout(()=>writeFileSync(join(r.workspacePath,'late-write'),'must not happen'),600);});\nprocess.on('SIGTERM',()=>process.stdout.write('EBO_OPENHANDS_SMOL '+JSON.stringify({state:'stopped'})+'\\n',()=>process.exit(0)));\n`, {mode: 0o700});
    const pending = startOpenHandsSmol({...request(root), signal: controller.signal, onStarting: () => {registered = true;}});
    const rejected = assert.rejects(pending, /RUNTIME_SMOL_FAILED/);
    for (let i = 0; i < 200; i++) {if (await stat(join(root, "starting")).then(() => true, () => false)) break; await new Promise(resolve => setTimeout(resolve, 10));}
    assert.equal(registered, true);
    assert.equal(await readFile(join(root, "starting"), "utf8"), "yes");
    controller.abort(); await rejected;
    await new Promise(resolve => setTimeout(resolve, 650));
    await assert.rejects(stat(join(root, "late-write")), {code: "ENOENT"});
  } finally {await rm(root, {recursive: true, force: true});}
});

test("an OpenHands worker starts only its HTTP child inside the existing Smol guest", {skip: process.platform !== "linux" || !process.env.EBO_TEST_SMOL_CGROUP_ROOT}, async () => {
  const root = await mkdtemp(join(tmpdir(), "ebo-smol-guest-server-"));
  let server: Awaited<ReturnType<typeof startOpenHandsInSmolGuest>> | undefined;
  try {
    const executable = join(root, "server.mjs");
    const release = join(root, "release-tool");
    const detachedTool = `const fs=require('node:fs');
      fs.writeFileSync(${JSON.stringify(join(root, "detached-tool-ready"))}, 'ready');
      const timer=setInterval(()=>{
        if(fs.existsSync(${JSON.stringify(release)})){
          clearInterval(timer);
          setTimeout(()=>fs.writeFileSync(${JSON.stringify(join(root, "late-tool-write"))}, 'must not happen'), 250);
        }
      },10);`;
    await writeFile(executable, `import http from 'node:http';import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';
      const args=process.argv;const port=Number(args[args.indexOf('--port')+1]);
      const tool=spawn(process.execPath,['-e',${JSON.stringify(detachedTool)}],{detached:true,stdio:['ignore','ignore','inherit']});tool.unref();
      process.on('SIGTERM',()=>{writeFileSync(${JSON.stringify(release)},'server exited');process.exit(0);});
      setTimeout(()=>http.createServer((req,res)=>{
        res.setHeader('Content-Type','application/json');
        res.end(JSON.stringify({version:'fixture',toolPid:tool.pid,uid:process.getuid(),gid:process.getgid()}));
      }).listen(port,'127.0.0.1'),150);`);
    const user = process.getuid!() === 0 ? '1001:1001' : `${process.getuid!()}:${process.getgid!()}`;
    if (process.getuid!() === 0) await chown(root, 1001, 1001);
    const input = {...request(root), workspaceUser: user, python: "/must-not-launch-a-nested-smol-interpreter", command: [process.execPath, executable, "--host", "0.0.0.0", "--port", "8000"]};
    const binding = {schemaVersion: "ebo.smol-owned-task/v1" as const, image: input.image, imageConfigDigest: input.configDigest, machine: "owned-task-vm", bootId: (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(), engineVersion: input.engineVersion, libkrunSha256: "b".repeat(64), serverCgroupRoot: process.env.EBO_TEST_SMOL_CGROUP_ROOT};
    server = await startOpenHandsInSmolGuest(input, binding);
    const response = await fetch(server.baseUrl + "/server_info");
    const identity = await response.json() as {version: string; toolPid: number; uid: number; gid: number};
    assert.equal(identity.version, "fixture");
    assert.equal(`${identity.uid}:${identity.gid}`, user);
    assert.equal(server.binding.actualUser, user);
    assert.equal(server.binding.kind, "smol-guest-server");
    for (let i = 0; i < 200; i++) {if (await stat(join(root, "detached-tool-ready")).then(() => true, () => false)) break; await new Promise(resolve => setTimeout(resolve, 10));}
    assert.equal(await readFile(join(root, "detached-tool-ready"), "utf8"), "ready");
    const pid = Number(server.binding.serverPid); await server.stop();
    assert.equal(server.isStopped(), true);
    assert.throws(() => process.kill(pid, 0), {code: "ESRCH"});
    await writeFile(join(root, "release-tool"), "go");
    await new Promise(resolve => setTimeout(resolve, 650));
    await assert.rejects(stat(join(root, "late-tool-write")), {code: "ENOENT"});
    await assert.rejects(startOpenHandsInSmolGuest(input, {...binding, bootId: "foreign-boot"}), /RUNTIME_CONTAINER_BINDING_INVALID/);
  } finally {await server?.stop(); await rm(root, {recursive: true, force: true});}
});

import assert from "node:assert/strict";
import test from "node:test";
import {runOfficialHarborTrial} from "../src/harbor/official-trial.js";
import {runHarborBackedQueueEntry} from "../src/harbor/runner.js";
import {serveSmolEnvironments} from "../src/harbor/smol.js";
import {runHarborWorker} from "../src/harbor/worker.js";

test("Harbor and Smol execution require the study lock before inspecting execution inputs", async () => {
  await assert.rejects(runOfficialHarborTrial({} as any), /RUNTIME_STUDY_LOCK_REQUIRED/);
  await assert.rejects(runHarborBackedQueueEntry({} as any), /RUNTIME_STUDY_LOCK_REQUIRED/);
  await assert.rejects(serveSmolEnvironments("/missing", "/missing"), /RUNTIME_STUDY_LOCK_REQUIRED|ENOENT.*runtimes/);
  await assert.rejects(runHarborWorker({} as any), /RUNTIME_STUDY_LOCK_REQUIRED/);
});

test("a worker runtime can bind its archive to one study lock while historical worker metadata stays readable", async () => {
  const {mkdtemp, rm, writeFile} = await import("node:fs/promises");
  const {tmpdir} = await import("node:os"); const {join} = await import("node:path");
  const {digestBytes} = await import("../src/artifacts.js");
  const {resolveHarborWorkerRuntime} = await import("../src/harbor/official-trial.js");
  const root = await mkdtemp(join(tmpdir(), "ebo-worker-lock-"));
  try {
    const value = {schemaVersion: "ebo.harbor-worker-runtime/v2", archive: {locator: "worker.tgz", digest: {algorithm: "sha256", value: "b".repeat(64)}}, node: "node", entrypoint: "dist/src/harbor/worker.js", environmentKeys: [], studyLockDigest: `sha256:${"a".repeat(64)}`};
    const put = async (value: unknown) => {const bytes = Buffer.from(JSON.stringify(value)); await writeFile(join(root, "worker.json"), bytes); return {locator: "worker.json", digest: digestBytes(bytes)};};
    assert.equal(Reflect.get(resolveHarborWorkerRuntime(root, await put(value)), "studyLockDigest"), value.studyLockDigest);
    assert.throws(() => resolveHarborWorkerRuntime(root, {locator: "worker.json", digest: {algorithm: "sha256", value: "c".repeat(64)}}), /digest/i);
    assert.equal(resolveHarborWorkerRuntime(root, await put({...value, schemaVersion: "ebo.harbor-worker-runtime/v1"})).schemaVersion, "ebo.harbor-worker-runtime/v1");
  } finally {await rm(root, {recursive: true, force: true});}
});

test("worker packaging requires an immutable Node image and retains the selected study graph", async () => {
  const {mkdtemp, mkdir, readFile, rm, stat, writeFile} = await import("node:fs/promises");
  const {tmpdir} = await import("node:os"); const {dirname, join} = await import("node:path");
  const {execFile} = await import("node:child_process"); const {promisify} = await import("node:util"); const exec = promisify(execFile);
  const {freezeStudyRuntimes} = await import("../src/study-runtimes.js"); const {fakeSdkRuntimeOptions} = await import("./runtime-fixture-helper.js");
  const root = await mkdtemp(join(tmpdir(), "ebo-worker-package-")), study = join(root, "study"), output = join(root, "output"), bin = join(root, "bin"), calls = join(root, "docker-call.json");
  await mkdir(bin);
  try {
    const lock = await freezeStudyRuntimes(study, {studyId: "worker-package", roles: ["pi-sdk"], target: {platform: "linux", architecture: "arm64"}}, fakeSdkRuntimeOptions("9.9.9"));
    const fakeDocker = `#!${process.execPath}\nimport {cp,mkdir,mkdtemp,writeFile} from 'node:fs/promises';import {join} from 'node:path';import {execFileSync} from 'node:child_process';const args=process.argv.slice(2);await writeFile(${JSON.stringify(calls)},JSON.stringify(args));const mount=target=>args.find(v=>v.includes('target='+target)).split(',')[1].slice(7);const out=mount('/output'),study=mount('/study');const stage=await mkdtemp(join(out,'stage-'));await mkdir(join(stage,'study'));await cp(join(study,'runtimes'),join(stage,'study','runtimes'),{recursive:true});execFileSync('tar',['-czf',join(out,'worker.tgz'),'-C',stage,'.']);await writeFile(join(out,'node-version.txt'),process.version);\n`;
    await writeFile(join(bin, "docker"), fakeDocker, {mode: 0o700});
    const env = {...process.env, PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}`}, script = "scripts/build-harbor-runtime.mjs";
    await assert.rejects(exec(process.execPath, [script, output, "--study", study, "--node-image", "node:latest"], {env}), /immutable/);
    await assert.rejects(stat(calls), {code: "ENOENT"});
    const image = `docker.io/library/node@sha256:${"d".repeat(64)}`;
    await exec(process.execPath, [script, output, "--study", study, "--node-image", image], {env});
    const runtime = JSON.parse(await readFile(join(output, "worker.json"), "utf8"));
    assert.equal(runtime.schemaVersion, "ebo.harbor-worker-runtime/v2"); assert.equal(runtime.studyLockDigest, lock.digest);
    assert.ok(JSON.parse(await readFile(calls, "utf8")).includes(image));
    const metadata = await exec("tar", ["-xOf", join(output, "worker.tgz"), `./study/runtimes/cache/${lock.groups[0]!.installation.key}/node_modules/@earendil-works/pi-coding-agent/package.json`]);
    assert.equal(JSON.parse(metadata.stdout).version, "9.9.9");
  } finally {await rm(root, {recursive: true, force: true});}
});

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

test("worker packaging uses local Smol and retains the immutable image and study graph", async () => {
  const {mkdtemp, mkdir, readFile, rm, cp, writeFile} = await import("node:fs/promises");
  const {tmpdir} = await import("node:os"); const {join} = await import("node:path");
  const {execFile} = await import("node:child_process"); const {promisify} = await import("node:util"); const exec = promisify(execFile);
  const {freezeStudyRuntimes} = await import("../src/study-runtimes.js"); const {fakeSdkRuntimeOptions} = await import("./runtime-fixture-helper.js");
  const {buildHarborRuntime} = await import(new URL("../../scripts/build-harbor-runtime.mjs", import.meta.url).href);
  const root = await mkdtemp(join(tmpdir(), "ebo-worker-package-")), study = join(root, "study"), output = join(root, "output");
  try {
    const lock = await freezeStudyRuntimes(study, {studyId: "worker-package", roles: ["pi-sdk"], target: {platform: "linux", architecture: "arm64"}}, fakeSdkRuntimeOptions("9.9.9"));
    let invoked = false;
    await assert.rejects(buildHarborRuntime({destination: output, study, nodeImage: "node:latest"}, () => {invoked = true;}), /immutable/);
    assert.equal(invoked, false);
    const image = `docker.io/library/node@sha256:${"d".repeat(64)}`;
    const {engines, packageManager} = JSON.parse(await readFile("package.json", "utf8"));
    const npmVersion = packageManager.slice("npm@".length);
    const prepare = async (request: any) => {
      invoked = true;
      assert.equal(request.image, image);
      assert.deepEqual(request.mounts.map((mount: any) => [mount.target, mount.readOnly]), [["/source", true], ["/study", true], ["/output", false]]);
      const stage = join(root, "stage"); await mkdir(join(stage, "study"), {recursive: true});
      await cp(join(study, "runtimes"), join(stage, "study/runtimes"), {recursive: true});
      const stagedOutput = request.mounts.find((mount: any) => mount.target === "/output").source;
      await exec("tar", ["-czf", join(stagedOutput, "worker.tgz"), "-C", stage, "."]);
      await writeFile(join(stagedOutput, "node-version.txt"), `v${engines.node}`);
      await writeFile(join(stagedOutput, "npm-version.txt"), npmVersion);
      return {backend: "smolvm", target: "local", image, imageConfigDigest: "authored-config", machine: "authored-build-vm"};
    };
    const build = await buildHarborRuntime({destination: output, study, nodeImage: image}, prepare);
    assert.equal(invoked, true); assert.equal(build.execution.backend, "smolvm");
    assert.equal(build.npmVersion, npmVersion);
    const runtime = JSON.parse(await readFile(join(output, "worker.json"), "utf8"));
    assert.equal(runtime.schemaVersion, "ebo.harbor-worker-runtime/v2"); assert.equal(runtime.studyLockDigest, lock.digest);
    const metadata = await exec("tar", ["-xOf", join(output, "worker.tgz"), `./study/runtimes/cache/${lock.groups[0]!.installation.key}/node_modules/@earendil-works/pi-coding-agent/package.json`]);
    assert.equal(JSON.parse(metadata.stdout).version, "9.9.9");
    const validArchive = await readFile(join(output, "worker.tgz"));
    await assert.rejects(buildHarborRuntime({destination: output, study, nodeImage: image}, async (request: any) => {
      const result = await prepare(request);
      const stagedOutput = request.mounts.find((mount: any) => mount.target === "/output").source;
      await writeFile(join(stagedOutput, "npm-version.txt"), "0.0.0");
      await writeFile(join(stagedOutput, "worker.tgz"), "different worker archive");
      return result;
    }), /Worker npm probe disagrees/);
    assert.deepEqual(await readFile(join(output, "worker.tgz")), validArchive);
    await assert.rejects(buildHarborRuntime({destination: output, study, nodeImage: image}, async () => ({backend: "docker", target: "local", image, imageConfigDigest: "authored-config"})), /local Smol/);
  } finally {await rm(root, {recursive: true, force: true});}
});

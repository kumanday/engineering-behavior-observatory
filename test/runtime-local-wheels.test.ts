import {validateArtifact} from "../src/artifacts.js";
import assert from "node:assert/strict";
import test from "node:test";
import {createHash} from "node:crypto";
import {mkdtemp, readFile, rename, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {admitLocalPythonWheels, retainedLocalWheel} from "../src/runtime-local-wheels.js";
import {downloadRuntimeArtifact} from "../src/runtime-artifacts.js";
import {freezeStudyRuntimes, prepareRuntimeLaunch} from "../src/study-runtimes.js";
import {fakePythonRuntimeOptions} from "./runtime-python-fixture.js";
import {refreshFrozenRuntimeRelease} from "../src/runtime-status.js";

const hash = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
async function fixture(wheel = Buffer.from("authored immutable wheel boundary fixture")) {
  const root = await mkdtemp(join(tmpdir(), "ebo-local-wheel-")), filename = "pyyaml-6.0.3-cp313-cp313-macosx_11_0_arm64.whl";
  const source = {url: "https://files.pythonhosted.org/pyyaml-6.0.3.tar.gz", sha256: hash("released source"), publishedAt: "2026-11-01T00:00:00Z"};
  const provenance = {schemaVersion: "ebo.python-wheel-build/v1", name: "pyyaml", version: "6.0.3", wheel: {filename, sha256: hash(wheel)}, source,
    builtAt: "2026-11-08T12:00:00Z", target: {python: "3.13.1", platform: `${process.platform}-${process.arch}`, abi: "cp313"}, recipe: {sha256: hash("reviewed build recipe")},
    buildTools: [{name: "Cython", version: "3.3.1"}], tests: [{name: "upstream", status: "passed", exitCode: 0, sha256: hash("test log")}],
    securityComponents: [{id: "wheel-build:Cython", name: "Cython", version: "3.3.1", ecosystem: "PyPI"}]};
  const manifest = join(root, "wheelhouse.json"), receipt = JSON.stringify(provenance);
  await writeFile(join(root, filename), wheel); await writeFile(join(root, "provenance.json"), receipt);
  await writeFile(manifest, JSON.stringify({schemaVersion: "ebo.local-python-wheels/v1", wheels: [{wheel: filename, sha256: hash(wheel), provenance: "provenance.json", provenanceSha256: hash(receipt)}]}));
  const base = fakePythonRuntimeOptions(), original = base.run!, fetch = base.fetch!;
  const sourceFile = {filename: "pyyaml-6.0.3.tar.gz", url: source.url, digests: {sha256: source.sha256}, upload_time_iso_8601: source.publishedAt, packagetype: "sdist", yanked: false};
  let localUrl = "";
  const options = {...base, pythonWheelhouse: manifest, run: async (command: string, args: readonly string[], cwd: string) => {
    if (args.includes("--output-file")) {
      const input = await readFile(args[2]!, "utf8"); localUrl = (input.split("\n").find(line => line.startsWith("pyyaml @ "))?.slice("pyyaml @ ".length) ?? "file:///unadmitted.whl");
      await writeFile(args[args.indexOf("--output-file") + 1]!, input); return {code: 0, stdout: "", stderr: ""};
    }
    if (args.includes("--report")) {
      const bytes = Buffer.from("authored wheel command fixture"), sha = hash(bytes);
      await writeFile(args[args.indexOf("--report") + 1]!, JSON.stringify({install: [
        {metadata: {name: "harbor", version: "0.25.0"}, download_info: {url: "https://files.pythonhosted.org/harbor.whl", archive_info: {hashes: {sha256: sha}}}},
        {metadata: {name: "PyYAML", version: "6.0.3"}, download_info: {url: localUrl, archive_info: {hashes: {sha256: hash(wheel)}}}},
      ]})); return {code: 0, stdout: "", stderr: ""};
    }
    return original(command, args, cwd);
  }, fetch: async (url: string, init?: RequestInit) => url.includes("/pyyaml/") ? Response.json({urls: [sourceFile], releases: {"6.0.3": [sourceFile]}}) : fetch(url, init)};
  return {root, wheel, filename, sourceFile, provenance, manifest, options};
}

test("local wheel admission rejects modified bytes before resolution", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, f.filename), "changed");
    await assert.rejects(admitLocalPythonWheels(f.manifest, f.root), /RUNTIME_LOCAL_WHEEL_INVALID/);
  } finally {await rm(f.root, {recursive: true, force: true});}
});

test("a prepared wheel larger than 16 MiB installs through the same retained-byte contract", async () => {
  const f = await fixture(Buffer.alloc(17 * 1024 * 1024, 42));
  try {
    const [admitted] = await admitLocalPythonWheels(f.manifest);
    const destination = join(f.root, "retained.whl");
    await downloadRuntimeArtifact({locator: `ebo-wheel:sha256:${admitted!.sha256}`, integrity: `sha256-${Buffer.from(admitted!.sha256, "hex").toString("base64")}`,
      filename: admitted!.filename, localWheel: retainedLocalWheel(admitted!)}, destination);
    assert.equal(hash(await readFile(destination)), admitted!.sha256);
  } finally {await rm(f.root, {recursive: true, force: true});}
});

test("freeze rejects a retained wheel payload that cannot fit a qualification artifact", async () => {
  const f = await fixture(Buffer.alloc(48 * 1024 * 1024, 42));
  try {
    const study = join(f.root, "study");
    await assert.rejects(freezeStudyRuntimes(study, {studyId: "oversized-retained-lock", roles: ["harbor"]}, f.options), /RUNTIME_LOCK_TOO_LARGE/);
    await assert.rejects(readFile(join(study, "runtimes/lock.json")), {code: "ENOENT"});
  } finally {await rm(f.root, {recursive: true, force: true});}
});

test("an explicitly admitted new build freezes source age separately and installs retained bytes without a build", async () => {
  const f = await fixture();
  try {
    const lock = await freezeStudyRuntimes(join(f.root, "study"), {studyId: "local-wheel", roles: ["harbor"]}, f.options);
    assert.deepEqual(validateArtifact("Runtime lock", lock), []);
    const group = lock.groups[0]!; assert.equal(group.plan.kind, "python"); if (group.plan.kind !== "python") throw new Error("Expected Python");
    const artifact = group.plan.artifacts.find(artifact => artifact.localWheel)!;
    assert.equal(artifact.localWheel!.provenance.builtAt, f.provenance.builtAt);
    const component = group.components.find(component => component.name === "pyyaml")!;
    assert.equal(component.selection.release.publishedAt, f.sourceFile.upload_time_iso_8601);
    assert.match(component.selection.release.locator, /^ebo-wheel:sha256:/u);
    assert.ok(lock.security.components.some(component => component.query.package && "name" in component.query.package && component.query.package.name === "Cython"));
    const receipt = JSON.parse(await readFile(join(f.root, "study/runtimes/cache", group.installation.key, ".ebo-runtime-receipt.json"), "utf8"));
    assert.ok(receipt.proofs.some((proof: any) => proof.kind === "operator-built-wheel"));
    await rm(join(f.root, f.filename)); await rm(f.manifest);
    const retained = join(f.root, "retained.whl"); await downloadRuntimeArtifact(artifact, retained);
    assert.deepEqual(await readFile(retained), f.wheel);
    await assert.rejects(downloadRuntimeArtifact({...artifact, localWheel: {...artifact.localWheel!, bytesBase64: Buffer.from("changed").toString("base64")}}, join(f.root, "tampered.whl")), /RUNTIME_INTEGRITY_MISMATCH/);
    await refreshFrozenRuntimeRelease({source: "pypi", name: "pyyaml"}, component.selection.release, f.options);
    f.sourceFile.yanked = true;
    await assert.rejects(refreshFrozenRuntimeRelease({source: "pypi", name: "pyyaml"}, component.selection.release, f.options), /RUNTIME_RELEASE_WITHDRAWN/);
  } finally {await rm(f.root, {recursive: true, force: true});}
});

test("a malicious-package advisory on a retained build input blocks each launch", async () => {
  const f = await fixture();
  try {
    const study = join(f.root, "study"); await freezeStudyRuntimes(study, {studyId: "local-wheel-security", roles: ["harbor"]}, f.options);
    await assert.rejects(prepareRuntimeLaunch(study, "harbor", {...f.options, query: async query => "name" in query.package && query.package.name === "Cython" ? {vulns: [{id: "MAL-2026-local-build-fixture"}]} : {}}), /RUNTIME_MALICIOUS/);
  } finally {await rm(f.root, {recursive: true, force: true});}
});

test("a repackaged stable-ABI wheel retains and rechecks its upstream binary input", async () => {
  const f = await fixture();
  try {
    const filename = "pyyaml-6.0.3-cp310-abi3-macosx_11_0_arm64.whl";
    await rename(join(f.root, f.filename), join(f.root, filename));
    const binary = {url: "https://files.pythonhosted.org/upstream-pyyaml.whl", sha256: hash("upstream native wheel"), publishedAt: "2026-11-01T01:00:00Z"};
    const binaryFile = {filename, url: binary.url, digests: {sha256: binary.sha256}, upload_time_iso_8601: binary.publishedAt, packagetype: "bdist_wheel", yanked: false};
    const provenance = {...f.provenance, target: {...f.provenance.target, abi: "abi3"}, wheel: {...f.provenance.wheel, filename}, upstreamWheel: binary};
    const receipt = JSON.stringify(provenance); await writeFile(join(f.root, "provenance.json"), receipt);
    const manifest = JSON.parse(await readFile(f.manifest, "utf8")); manifest.wheels[0].wheel = filename; manifest.wheels[0].provenanceSha256 = hash(receipt); await writeFile(f.manifest, JSON.stringify(manifest));
    const fallback = f.options.fetch;
    const options = {...f.options, fetch: async (url: string, init?: RequestInit) => url.includes("/pyyaml/")
      ? Response.json({urls: [f.sourceFile, binaryFile], releases: {"6.0.3": [f.sourceFile, binaryFile]}}) : fallback(url, init)};
    const study = join(f.root, "study");
    const lock = await freezeStudyRuntimes(study, {studyId: "binary-wheel", roles: ["harbor"]}, options);
    assert.deepEqual(validateArtifact("Runtime lock", lock), []);
    const component = lock.groups[0]!.components.find(component => component.name === "pyyaml")!;
    assert.equal(component.selection.release.publishedAt, binary.publishedAt);
    binaryFile.digests.sha256 = hash("changed upstream binary");
    await assert.rejects(prepareRuntimeLaunch(study, "harbor", options), /RUNTIME_INTEGRITY_MISMATCH/);
    binaryFile.digests.sha256 = binary.sha256; binaryFile.yanked = true;
    await assert.rejects(prepareRuntimeLaunch(study, "harbor", options), /RUNTIME_RELEASE_WITHDRAWN/);
  } finally {await rm(f.root, {recursive: true, force: true});}
});

test("source age is enforced for a locally built wheel", async () => {
  const f = await fixture();
  try {
    f.provenance.source.publishedAt = f.sourceFile.upload_time_iso_8601 = "2026-11-07T11:00:00Z";
    const receipt = JSON.stringify(f.provenance); await writeFile(join(f.root, "provenance.json"), receipt);
    const manifest = JSON.parse(await readFile(f.manifest, "utf8")); manifest.wheels[0].provenanceSha256 = hash(receipt); await writeFile(f.manifest, JSON.stringify(manifest));
    await assert.rejects(freezeStudyRuntimes(join(f.root, "study"), {studyId: "new-source", roles: ["harbor"]}, f.options), /release-too-new/);
  } finally {await rm(f.root, {recursive: true, force: true});}
});

test("a local report has no implicit admission path", async () => {
  const f = await fixture();
  try {await assert.rejects(freezeStudyRuntimes(join(f.root, "study"), {studyId: "not-admitted", roles: ["harbor"]}, {...f.options, pythonWheelhouse: undefined}), /RUNTIME_INTEGRITY_MISMATCH/);}
  finally {await rm(f.root, {recursive: true, force: true});}
});

test("an upstream patch has its own immutable identity and release-age gate", async () => {
  const f = await fixture();
  try {
    const provenance = {...f.provenance, patches: [{url: "https://github.com/example/project/commit/" + "a".repeat(40), commit: "a".repeat(40), sha256: hash("pinned patch"), publishedAt: "2026-11-07T11:00:00Z", status: "open PR"}]};
    const save = async () => {
      const receipt = JSON.stringify(provenance); await writeFile(join(f.root, "provenance.json"), receipt);
      const manifest = JSON.parse(await readFile(f.manifest, "utf8")); manifest.wheels[0].provenanceSha256 = hash(receipt); await writeFile(f.manifest, JSON.stringify(manifest));
    };
    await save();
    await assert.rejects(freezeStudyRuntimes(join(f.root, "study"), {studyId: "new-patch", roles: ["harbor"]}, f.options), /release-too-new/);
    provenance.patches[0]!.commit = "moving-branch"; await save();
    await assert.rejects(admitLocalPythonWheels(f.manifest), /Source patches require an exact commit/);
  } finally {await rm(f.root, {recursive: true, force: true});}
});

test("reopening a frozen study validates an explicitly supplied wheelhouse", async () => {
  const f = await fixture();
  try {
    const study = join(f.root, "study"), request = {studyId: "frozen-admission", roles: ["harbor"]};
    await freezeStudyRuntimes(study, request, f.options);
    await assert.rejects(freezeStudyRuntimes(study, request, {...f.options, pythonWheelhouse: join(f.root, "missing.json")}), /ENOENT/);
    f.provenance.builtAt = "2026-11-08T13:00:00Z";
    const receipt = JSON.stringify(f.provenance); await writeFile(join(f.root, "provenance.json"), receipt);
    const manifest = JSON.parse(await readFile(f.manifest, "utf8")); manifest.wheels[0].provenanceSha256 = hash(receipt); await writeFile(f.manifest, JSON.stringify(manifest));
    await assert.rejects(freezeStudyRuntimes(study, request, f.options), /RUNTIME_STUDY_FROZEN/);
  } finally {await rm(f.root, {recursive: true, force: true});}
});

test("a declared build tool cannot be omitted from launch advisory checks", async () => {
  const f = await fixture();
  try {
    f.provenance.buildTools.push({name: "wheel", version: "0.48.0"});
    const receipt = JSON.stringify(f.provenance); await writeFile(join(f.root, "provenance.json"), receipt);
    const manifest = JSON.parse(await readFile(f.manifest, "utf8")); manifest.wheels[0].provenanceSha256 = hash(receipt); await writeFile(f.manifest, JSON.stringify(manifest));
    await assert.rejects(admitLocalPythonWheels(f.manifest), /Every pinned Python build tool/);
  } finally {await rm(f.root, {recursive: true, force: true});}
});

test("declared LibYAML must participate in advisory checks", async () => {
  const f = await fixture();
  try {
    const provenance = {...f.provenance, libyaml: {version: "0.2.5"}};
    const receipt = JSON.stringify(provenance); await writeFile(join(f.root, "provenance.json"), receipt);
    const manifest = JSON.parse(await readFile(f.manifest, "utf8")); manifest.wheels[0].provenanceSha256 = hash(receipt); await writeFile(f.manifest, JSON.stringify(manifest));
    await assert.rejects(admitLocalPythonWheels(f.manifest), /LibYAML build input/);
    provenance.securityComponents.push({id: "wheel-build:libyaml", name: "yaml/libyaml", version: "0.2.5", ecosystem: undefined as unknown as string, purl: "pkg:github/yaml/libyaml"} as typeof provenance.securityComponents[number]);
    const updated = JSON.stringify(provenance); await writeFile(join(f.root, "provenance.json"), updated); manifest.wheels[0].provenanceSha256 = hash(updated); await writeFile(f.manifest, JSON.stringify(manifest));
    const study = join(f.root, "study"); await freezeStudyRuntimes(study, {studyId: "libyaml-security", roles: ["harbor"]}, f.options);
    await assert.rejects(prepareRuntimeLaunch(study, "harbor", {...f.options, query: async query => "purl" in query.package ? {vulns: [{id: "MAL-2026-libyaml-fixture"}]} : {}}), /RUNTIME_MALICIOUS/);
  } finally {await rm(f.root, {recursive: true, force: true});}
});

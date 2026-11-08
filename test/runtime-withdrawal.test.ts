import assert from "node:assert/strict";
import test from "node:test";
import {createHash} from "node:crypto";
import {mkdir, mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {withStudyRuntime} from "../src/runtime-context.js";
import {freezeStudyRuntimes, prepareRuntimeLaunch, type StudyRuntimeOptions} from "../src/study-runtimes.js";

test("a frozen Python launch checks its selected wheel for yanking and changed integrity", async () => {
  const root = await mkdtemp(join(tmpdir(), "ebo-wheel-withdrawal-")), bytes = Buffer.from("authored wheel fixture");
  const version = "0.25.0", url = "https://files.pythonhosted.org/harbor.whl", filename = "harbor-0.25.0-py3-none-any.whl";
  const sha = createHash("sha256").update(bytes).digest("hex"); let yanked = false, changed = false, interpreterChanged = false, packageChanged = false;
  const bootstrap = {schemaVersion: "ebo.python-bootstrap/v1", executable: "/python", version: "3.13.1", abi: "cpython-313-fixture", platform: process.platform, architecture: process.arch, binaryIntegrity: `sha256-${Buffer.alloc(32).toString("base64")}`};
  const files = () => [{filename, url, upload_time_iso_8601: "2026-11-05T00:00:00Z", digests: {sha256: changed ? "b".repeat(64) : sha}, yanked},
    {filename: "harbor-0.25.0-py2-none-any.whl", url: "https://files.pythonhosted.org/unused.whl", upload_time_iso_8601: "2026-11-05T00:00:00Z", digests: {sha256: sha}, yanked: false}];
  const options: StudyRuntimeOptions = {now: () => "2026-11-07T12:00:00Z", query: async () => ({}), fetch: async (request) => {
    if (request === url) return new Response(bytes);
    return new Response(JSON.stringify(request.includes("/simple/") ? {files: [{filename}]} : {releases: {[version]: files()}, urls: files()}));
  }, run: async (_command, args) => {
    if (args.includes("-c")) return {code: 0, stdout: JSON.stringify(args.includes("ebo-package-versions") ? {harbor: packageChanged ? "99.9.9" : version} : {...bootstrap, version: interpreterChanged ? "3.14.0" : bootstrap.version}), stderr: ""};
    if (args.includes("--output-file")) await writeFile(args[args.indexOf("--output-file") + 1]!, `harbor==${version} --hash=sha256:${sha}\n`);
    if (args.includes("--report")) await writeFile(args[args.indexOf("--report") + 1]!, JSON.stringify({install: [{metadata: {name: "harbor", version}, download_info: {url, archive_info: {hashes: {sha256: sha}}}}]}));
    if (args.includes("venv")) {const bin = join(args.at(-1)!, "bin"); await mkdir(bin, {recursive: true}); await writeFile(join(bin, "python"), "authored interpreter command fixture\n");}
    return {code: 0, stdout: "", stderr: ""};
  }};
  try {
    await freezeStudyRuntimes(root, {studyId: "wheel-withdrawal", roles: ["harbor"]}, options);
    await prepareRuntimeLaunch(root, "harbor", options);
    await withStudyRuntime({studyRoot: root, role: "harbor", options}, async () => undefined);
    packageChanged = true;
    await assert.rejects(withStudyRuntime({studyRoot: root, role: "harbor", options}, async () => undefined), /RUNTIME_PROBE_MISMATCH/);
    packageChanged = false; interpreterChanged = true;
    await assert.rejects(prepareRuntimeLaunch(root, "harbor", options), /RUNTIME_PYTHON_BOOTSTRAP_MISMATCH/);
    interpreterChanged = false; yanked = true;
    await assert.rejects(prepareRuntimeLaunch(root, "harbor", options), /RUNTIME_RELEASE_WITHDRAWN/);
    yanked = false; changed = true;
    await assert.rejects(prepareRuntimeLaunch(root, "harbor", options), /RUNTIME_INTEGRITY_MISMATCH/);
  } finally {await rm(root, {recursive: true, force: true});}
});

test("a frozen image uses its manifest digest after tag removal and verifies Docker's actual config", async () => {
  const {fakeOciRuntimeOptions} = await import("./runtime-oci-fixture.js");
  const root = await mkdtemp(join(tmpdir(), "ebo-image-withdrawal-")), options = fakeOciRuntimeOptions();
  const fetch = options.fetch!, run = options.run!; let tagRemoved = false, digestRemoved = false, localChanged = false;
  options.fetch = async (url, init) => {
    if (url.includes("tags/list") && tagRemoved) return new Response(JSON.stringify({tags: []}));
    if (url.includes("/manifests/sha256:") && digestRemoved) return new Response("", {status: 404});
    return fetch(url, init);
  };
  options.run = async (command, args, cwd) => localChanged && args.includes("inspect") ? {code: 0, stdout: JSON.stringify([{Id: `sha256:${"c".repeat(64)}`}]), stderr: ""} : run(command, args, cwd);
  try {
    await freezeStudyRuntimes(root, {studyId: "image-withdrawal", roles: ["openhands-agent-server"]}, options);
    tagRemoved = true;
    await prepareRuntimeLaunch(root, "openhands-agent-server", options);
    localChanged = true;
    await assert.rejects(prepareRuntimeLaunch(root, "openhands-agent-server", options), /RUNTIME_INTEGRITY_MISMATCH/);
    localChanged = false; digestRemoved = true;
    await assert.rejects(prepareRuntimeLaunch(root, "openhands-agent-server", options), /RUNTIME_RELEASE_WITHDRAWN/);
  } finally {await rm(root, {recursive: true, force: true});}
});

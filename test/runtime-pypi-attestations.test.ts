import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp, readFile, rm, stat} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {freezeStudyRuntimes, prepareRuntimeLaunch} from "../src/study-runtimes.js";
import {installRuntime} from "../src/runtime-installation.js";
import {fakePythonRuntimeOptions} from "./runtime-python-fixture.js";

test("PyPI verification checks the retained provenance file and rejects changed or invalid proofs", async () => {
  const root = await mkdtemp(join(tmpdir(), "ebo-pypi-proofs-")), options = fakePythonRuntimeOptions(), originalFetch = options.fetch!, originalRun = options.run!;
  const provenance = {version: 1, attestation_bundles: [{publisher: {kind: "GitHub", repository: "harbor-framework/harbor", workflow: "release.yml"}, attestations: []}]};
  let verified = 0, invalid = false;
  options.fetch = async (url, init) => {
    if (url.includes("/integrity/")) return Response.json(provenance);
    const response = await originalFetch(url, init);
    if (!url.includes("/simple/")) return response;
    const data = await response.json(); data.files[0].provenance = "https://pypi.org/integrity/harbor/provenance"; return Response.json(data);
  };
  options.run = async (command, args, cwd) => {
    if (!args.includes("pypi_attestations")) return originalRun(command, args, cwd);
    assert.ok(args.includes("--provenance-file"));
    assert.deepEqual(JSON.parse(await readFile(args[args.indexOf("--provenance-file") + 1]!, "utf8")), provenance);
    verified++;
    return {code: invalid ? 1 : 0, stdout: invalid ? "" : "OK: authored external verifier result", stderr: invalid ? "invalid attestation signature" : ""};
  };
  try {
    const lock = await freezeStudyRuntimes(root, {studyId: "pypi-proofs", roles: ["harbor"]}, options), group = lock.groups[0]!;
    assert.equal(verified, 1);
    const receipt = JSON.parse(await readFile(join(root, "runtimes/cache", group.installation.key, ".ebo-runtime-receipt.json"), "utf8"));
    const proof = receipt.proofs.find((proof: any) => proof.kind === "pypi-attestation");
    assert.deepEqual(JSON.parse(await readFile(join(root, "runtimes/cache", group.installation.key, proof.result.provenancePath), "utf8")), provenance);
    await prepareRuntimeLaunch(root, "harbor", options);
    const changed = structuredClone(group.plan);
    if (changed.kind !== "python") throw new Error("Expected Python plan");
    changed.artifacts[0]!.attestation!.provenance = {...provenance, version: 2};
    await assert.rejects(installRuntime(changed, {...options, cacheRoot: join(root, "changed-cache")}), /RUNTIME_INTEGRITY_MISMATCH/);
    assert.equal(verified, 1);
    invalid = true;
    await assert.rejects(freezeStudyRuntimes(join(root, "bad"), {studyId: "invalid-signature", roles: ["harbor"]}, options), /invalid attestation signature/);
    await assert.rejects(stat(join(root, "bad/runtimes/lock.json")), {code: "ENOENT"});
  } finally {await rm(root, {recursive: true, force: true});}
});

import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { listRuntimeRecipes } from "../src/runtime-catalog.js";
import { fetchRuntimeReleases } from "../src/runtime-registry.js";
import { selectRuntimeRelease } from "../src/runtime-resolution.js";
import { prepareHarnessVerification } from "../src/harness-verification-candidate.js";
import { freezeStudyRuntimes } from "../src/study-runtimes.js";
import { captureAntigravityCli } from "../src/antigravity.js";
import { fakeAntigravityRuntimeOptions } from "./antigravity-runtime-fixture.js";

test("Antigravity registry selects the newest age-eligible publisher archive for each supported target", async () => {
  for (const platform of ["darwin", "linux"]) for (const architecture of ["arm64", "x64"]) {
    const component = listRuntimeRecipes({platform, architecture}).find(r => r.id === "antigravity-cli")!.components[0]!;
    const name = `agy_cli_${platform === "darwin" ? "mac" : platform}_${architecture}.tar.gz`;
    assert.equal(component.repository, "google-antigravity/antigravity-cli");
    assert.ok(new RegExp(component.assetPattern!).test(name));
    assert.equal(new RegExp(component.assetPattern!).test(name.replace(".tar.gz", "_musl.tar.gz")), false);
    const releases = await fetchRuntimeReleases(component, {fetch: async url => {
      assert.ok(url.startsWith("https://api.github.com/repos/google-antigravity/antigravity-cli/releases?"));
      return Response.json([['1.5.10','2026-11-17T05:41:11Z'],['1.5.9','2026-11-14T05:39:50Z']].map(([tag_name,published_at]) => ({tag_name,published_at,
        assets:[{name,browser_download_url:`https://github.com/google-antigravity/antigravity-cli/releases/download/${tag_name}/${name}`,digest:`sha256:${"a".repeat(64)}`}]})));
    }});
    const selected = selectRuntimeRelease(releases,{now:"2026-11-17T11:35:26Z"});
    assert.equal(selected.release.version,"1.5.9");
    assert.ok(selected.excluded.some(r => r.version === "1.5.10" && r.reason === "release-too-new"));
  }
});
test("Antigravity can freeze a study and prepare an unadmitted probe without inference", async () => {
  const studyRoot = await mkdtemp(join(tmpdir(),"ebo-agy-probe-")), options = fakeAntigravityRuntimeOptions();
  try {
    await freezeStudyRuntimes(studyRoot,{studyId:"authored-probe",roles:["antigravity-cli"]},options);
    const candidate = await prepareHarnessVerification({studyRoot,role:"antigravity-cli"},options);
    assert.equal(candidate.receipt.subject.harness,"antigravity-cli");
    assert.equal(candidate.receipt.claims.installation,"checked");
    assert.equal(candidate.receipt.claims["runtime-probe"],"checked");
    assert.equal(candidate.receipt.claims.readback,undefined);
    assert.equal(candidate.receipt.scope,null);
  } finally {await rm(studyRoot,{recursive:true,force:true});}
});
test("Antigravity public capture requires a frozen study before accessing capture inputs", async () => {
  await assert.rejects(captureAntigravityCli({} as never),/RUNTIME_STUDY_LOCK_REQUIRED/u);
});

test("Antigravity qualification and provisioning entry points parse without execution", () => {
  for (const script of ["scripts/qualify-antigravity.mjs", "scripts/antigravity-guest-smoke.mjs", "scripts/freeze-antigravity-contract.mjs"]) {
    const result = spawnSync(process.execPath,["--check",script],{encoding:"utf8",timeout:5000});
    assert.equal(result.status,0,result.stderr);
  }
});

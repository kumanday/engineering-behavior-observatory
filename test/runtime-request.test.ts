import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp, rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {freezeStudyRuntimes} from "../src/study-runtimes.js";
import {fakeSdkRuntimeOptions} from "./runtime-fixture-helper.js";

test("runtime freeze rejects misspelled or unused policy inputs before registry access", async () => {
  const root = await mkdtemp(join(tmpdir(), "ebo-runtime-request-"));
  const base = {studyId: "request", roles: ["cursor-sdk"]};
  const invalid: unknown[] = [null, {...base, roles: "cursor-sdk"}, {...base, roles: []}, {...base, minReleaseAge: 0},
    {...base, policy: {allowPrerelease: "false"}}, {...base, policy: {minReleaseAgeMs: NaN}}, {...base, policy: {minReleasAgeMs: 0}},
    {...base, target: {platform: "linux"}}, {...base, roleTargets: {cursor: {platform: "linux", architecture: "x64"}}},
    {...base, overrides: {cursor: "1.2.3"}}, {...base, overrides: {"cursor-sdk": "latest"}},
    {...base, harnessPolicies: {cursor: {minReleaseAgeMs: 0}}}, {...base, roles: ["hermes"]}];
  try {
    for (const request of invalid) {
      let requests = 0;
      const options = fakeSdkRuntimeOptions("9.9.9");
      options.fetch = async () => {requests++; throw new Error("Unexpected registry request");};
      await assert.rejects(freezeStudyRuntimes(root, request as any, options), /RUNTIME_(STUDY|POLICY|ROLE|PLATFORM)_/);
      assert.equal(requests, 0, JSON.stringify(request));
    }
  } finally {await rm(root, {recursive: true, force: true});}
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const python = process.env.EBO_HARBOR_PYTHON;
const script = resolve("scripts/antigravity-guest-auth.py");
const image = "node@sha256:" + "a".repeat(64);

test("guest preparation accepts the personal OAuth flow and rejects project sign-in options", { skip: !python }, () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-agy-auth-preflight-"));
  try {
    const help = spawnSync(python!, [script, "--help"], { encoding: "utf8", timeout: 30_000 });
    assert.equal(help.status, 0, help.stderr);
    assert.equal(help.stdout.includes("--gcp-project"), false);
    const state = join(root, "guest");
    const result = spawnSync(python!, [script, "--state-root", state, "--image", image, "--study", root,
      "--gcp-project", "example-project"], { encoding: "utf8", timeout: 30_000 });
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stderr, /unrecognized arguments: --gcp-project/u);
    assert.equal(existsSync(state), false, "Rejected options must not create or overwrite state");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("guest branch verification rejects a business profile before connecting to its VM", { skip: !python }, () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-agy-personal-only-"));
  try {
    writeFileSync(join(root, "state.json"), JSON.stringify({ machine: "ebo-agy-auth-0123456789",
      phase: "login-returned", authentication: "oauth-business" }), { mode: 0o600 });
    const result = spawnSync(python!, [resolve("scripts/check-antigravity-guest-branch.py"),
      "--state-root", root, "--model", "gemini-4-argon-high", "--login-confirmed"], { encoding: "utf8", timeout: 30_000 });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /requires a personal OAuth parent/u);
    assert.equal(existsSync(join(root, "branch-verifications")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("guest preparation preserves an existing owner's state and SSH key", { skip: !python }, () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-agy-auth-owner-"));
  try {
    const state = join(root, "guest");
    mkdirSync(state, { mode: 0o700 });
    const receipt = '{"phase":"awaiting-google-sign-in","machine":"owned-parent"}\n';
    writeFileSync(join(state, "state.json"), receipt, { mode: 0o600 });
    writeFileSync(join(state, "ssh-key"), "existing-operator-key", { mode: 0o600 });
    const result = spawnSync(python!, [script, "--state-root", state, "--image", image, "--study", root], { encoding: "utf8", timeout: 30_000 });
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stderr, /existing VM evidence is never replaced/u);
    assert.equal(readFileSync(join(state, "state.json"), "utf8"), receipt);
    assert.equal(readFileSync(join(state, "ssh-key"), "utf8"), "existing-operator-key");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

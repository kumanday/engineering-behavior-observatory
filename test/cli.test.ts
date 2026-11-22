import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, realpathSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { main } from "../src/cli.js";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

test("help succeeds without configuring an evaluation", () => {
  let output = "";

  assert.equal(main(["--help"], (message) => (output += message)), 0);
  assert.match(output, /^Usage: ebo \[--help\]/);
});

test("a clean source checkout packs an executable ebo binary", () => {
  const installationRoot = mkdtempSync(join(tmpdir(), "ebo-bin-"));
  const sourceRoot = join(installationRoot, "source");
  const consumerRoot = join(installationRoot, "consumer");

  try {
    for (const file of execFileSync("git", ["ls-files", "-z"], {
      cwd: repositoryRoot,
    }).toString().split("\0").filter(Boolean)) {
      const destination = join(sourceRoot, file);

      mkdirSync(dirname(destination), { recursive: true });
      cpSync(join(repositoryRoot, file), destination);
    }
    assert.equal(existsSync(join(sourceRoot, "dist")), false);

    const npmEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: installationRoot,
      npm_config_userconfig: join(installationRoot, ".npmrc"),
    };
    delete npmEnvironment.npm_config_allow_scripts;

    execFileSync(
      "npm",
      ["ci"],
      { cwd: sourceRoot, env: npmEnvironment, stdio: "pipe" },
    );
    const packed = JSON.parse(
      execFileSync("npm", ["pack", "--json", "--silent"], {
        cwd: sourceRoot,
        encoding: "utf8",
        env: npmEnvironment,
      }),
    ) as Array<{ filename: string }> | Record<string, { filename: string }>;
    const {filename} = (Array.isArray(packed) ? packed : Object.values(packed))[0]!;

    assert.equal(existsSync(join(sourceRoot, "dist", "src", "cli.js")), true);
    mkdirSync(consumerRoot);
    writeFileSync(join(consumerRoot, "package.json"), '{"private":true}');
    execFileSync(
      "npm",
      ["install", "--no-audit", "--no-fund", join(sourceRoot, filename)],
      { cwd: consumerRoot, env: npmEnvironment, stdio: "pipe" },
    );

    const output = execFileSync(
      join(consumerRoot, "node_modules", ".bin", "ebo"),
      ["--help"],
      { encoding: "utf8" },
    );

    assert.match(output, /^Usage: ebo \[--help\]/);
    assert.equal(realpathSync(join(consumerRoot, "node_modules/.bin/ebo")), realpathSync(join(consumerRoot, "node_modules/engineering-behavior-observatory/dist/src/cli.js")));
    assert.equal(JSON.parse(readFileSync(join(consumerRoot, "node_modules/engineering-behavior-observatory/package.json"), "utf8")).version, JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")).version);
    const installed = realpathSync(join(consumerRoot, "node_modules/engineering-behavior-observatory"));
    const ebo = (args: string[]) => spawnSync(join(consumerRoot, "node_modules", ".bin", "ebo"), args, { cwd: consumerRoot, encoding: "utf8" });

    // Harbor lane, first documented step: the worker build preflight finds every source in the installed package,
    // including the npm lock that npm never packs at the root.
    const worker = ebo(["harbor", "build-worker", "--check"]);
    assert.equal(worker.status, 0, worker.stdout + worker.stderr);
    assert.equal(realpathSync(JSON.parse(worker.stdout).root), installed);
    assert.deepEqual(readFileSync(join(installed, "dist/harbor-worker/package-lock.json")), readFileSync(join(sourceRoot, "package-lock.json")));
    const builderUsage = ebo(["harbor", "build-worker", join(installationRoot, "worker-out")]);
    assert.equal(builderUsage.status, 1);
    assert.match(builderUsage.stdout + builderUsage.stderr, /--study <frozen-study> --node-image/);

    // Embedding lane, first documented step: the runtime check names the installed requirements and runs the
    // installed scripts (here through a stand-in interpreter that only proves each script exists).
    const embeddings = ebo(["atlas", "embeddings", "check"]);
    assert.equal(embeddings.status, 0, embeddings.stdout + embeddings.stderr);
    const report = JSON.parse(embeddings.stdout.slice(0, embeddings.stdout.lastIndexOf("}") + 1)) as { requirements: string };
    assert.equal(realpathSync(report.requirements), join(installed, "scripts/embeddings/requirements.txt"));
    const python = join(installationRoot, "python-stand-in");
    writeFileSync(python, '#!/bin/sh\n[ "$1" = "-I" ] && [ -f "$2" ] || { echo "missing script: $2" >&2; exit 3; }\necho "$2" >> "$0.log"\n', { mode: 0o755 });
    const checked = ebo(["atlas", "embeddings", "check", "--python", python]);
    assert.equal(checked.status, 0, checked.stdout + checked.stderr);
    assert.deepEqual(readFileSync(`${python}.log`, "utf8").trim().split("\n").map((path) => realpathSync(path)),
      [join(installed, "scripts/embeddings/embed.py"), join(installed, "scripts/embeddings/layout.py")]);
  } finally {
    rmSync(installationRoot, { force: true, recursive: true });
  }
});

test("build removes stale compiled tests before test discovery", () => {
  const installationRoot = mkdtempSync(join(tmpdir(), "ebo-clean-build-"));
  const sourceRoot = join(installationRoot, "source");

  try {
    for (const file of execFileSync("git", ["ls-files", "-z"], {
      cwd: repositoryRoot,
    }).toString().split("\0").filter(Boolean)) {
      const destination = join(sourceRoot, file);

      mkdirSync(dirname(destination), { recursive: true });
      cpSync(join(repositoryRoot, file), destination);
    }

    const npmEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: installationRoot,
      npm_config_userconfig: join(installationRoot, ".npmrc"),
    };
    delete npmEnvironment.npm_config_allow_scripts;
    const staleTest = join(sourceRoot, "dist", "test", "stale.test.js");

    execFileSync("npm", ["ci"], { cwd: sourceRoot, env: npmEnvironment, stdio: "pipe" });
    execFileSync("npm", ["run", "build"], { cwd: sourceRoot, env: npmEnvironment, stdio: "pipe" });
    writeFileSync(staleTest, "throw new Error('stale test should be removed');\n");
    execFileSync("npm", ["run", "build"], { cwd: sourceRoot, env: npmEnvironment, stdio: "pipe" });

    assert.equal(existsSync(staleTest), false);
  } finally {
    rmSync(installationRoot, { force: true, recursive: true });
  }
});

test("CLI import ignores a non-filesystem argv entry", () => {
  assert.doesNotThrow(() =>
    execFileSync(
      process.execPath,
      ["--input-type=module", "-e", "await import('./dist/src/cli.js')", "does-not-exist"],
      { cwd: repositoryRoot, stdio: "pipe" },
    ),
  );
});

test("generated output ignores are root-scoped", () => {
  const isIgnored = (path: string) =>
    spawnSync("git", ["check-ignore", "-q", path], { cwd: repositoryRoot })
      .status === 0;

  for (const path of [
    ".ebo/attempt.json",
    "collector/log.json",
    "workspaces/task",
    "run-bundles/attempt.json",
    "exports/portable.json",
  ]) {
    assert.equal(isIgnored(path), true, `${path} should be ignored`);
  }

  for (const path of [
    "src/collector/client.ts",
    "src/exports/format.ts",
    "test/fixtures/run-bundles/example.json",
    "schemas/run-bundles/v1.json",
  ]) {
    assert.equal(isIgnored(path), false, `${path} should remain trackable`);
  }
});

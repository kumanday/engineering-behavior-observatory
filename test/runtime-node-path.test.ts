import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp, writeFile, chmod, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {probeFactoryRuntime} from "../src/factory-droid.js";

test("an env-node runtime uses EBO's coordinating Node ahead of a conflicting ambient executable", async () => {
  const root = await mkdtemp(join(tmpdir(), "ebo-node-path-")), previous = process.env.PATH;
  try {
    const decoy = join(root, "node"), executable = join(root, "droid.mjs");
    await writeFile(decoy, "#!/bin/sh\necho 0.0.0\n"); await chmod(decoy, 0o700);
    await writeFile(executable, `#!/usr/bin/env node\nconsole.log(process.execPath === ${JSON.stringify(process.execPath)} ? '9.9.9' : '0.0.0');\n`); await chmod(executable, 0o700);
    process.env.PATH = root;
    assert.equal((await probeFactoryRuntime(executable)).version, "9.9.9");
  } finally {if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous; await rm(root, {recursive: true, force: true});}
});

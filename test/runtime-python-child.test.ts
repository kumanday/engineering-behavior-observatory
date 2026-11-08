import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp, readFile, realpath, rm, stat, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {invokeTrial} from "../src/harbor/official-trial.js";

test("operational Harbor Python children leave imported source bytes and cache inventories unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "ebo-python-immutable-"));
  try {
    await writeFile(join(root, "marker.py"), "value = 1\n");
    const script = join(root, "trial.py"); await writeFile(script, "import marker\nprint(marker.value)\n");
    const result = await invokeTrial(process.env.EBO_HARBOR_PYTHON ?? "python3", script, "unused", undefined, 5000);
    assert.equal(result.code, 0, result.stderr); assert.equal(result.stdout.trim(), "1");
    assert.equal(await readFile(join(root, "marker.py"), "utf8"), "value = 1\n");
    await assert.rejects(stat(join(root, "__pycache__")), {code: "ENOENT"});
  } finally {await rm(root, {recursive: true, force: true});}
});

test("a Python bootstrap preserves the selected virtual environment executable", async () => {
  const {probePythonBootstrap} = await import("../src/runtime-bootstrap.js");
  const {runRuntimeCommand} = await import("../src/runtime-installation.js");
  const root = await mkdtemp(join(tmpdir(), "ebo-python-bootstrap-"));
  try {
    const created = await runRuntimeCommand(process.env.EBO_HARBOR_PYTHON ?? "python3", ["-I", "-B", "-m", "venv", "--without-pip", join(root, "venv")], root);
    assert.equal(created.code, 0, created.stderr);
    const selected = join(root, "venv", "bin", "python");
    const identity = await probePythonBootstrap(selected, runRuntimeCommand, root);
    assert.equal(identity.executable, join(await realpath(join(root, "venv", "bin")), "python"));
  } finally {await rm(root, {recursive: true, force: true});}
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import ts from "typescript";
import { containsPortableLocalHomePath, containsPortableSecretPattern } from "../src/exports.js";

test("release source scan accepts reference-only Bearer headers and rejects credential literals", async () => {
  const { maskSourceIdentifierAssignments } = await import(pathToFileURL(resolve("scripts/release-source-scan.mjs")).href);
  const scan = (source: string) => containsPortableSecretPattern(maskSourceIdentifierAssignments(source, "fixture.ts", ts), "text/plain");
  assert.equal(scan('const headers = {Authorization: `Bearer ${key!}`};'), false);
  assert.equal(scan('const headers = {Authorization: `Bearer ${process.env.FIREWORKS_API_KEY}`};'), false);
  for (const source of [
    'const headers = {Authorization: "Bearer syntheticcredentialvalue"};',
    'const headers = {Authorization: `Bearer syntheticcredentialvalue${key}`};',
    'const headers = {Authorization: `Bearer ${"syntheticcredentialvalue"}`};',
    'const headers = {Authorization: `Bearer ${key}syntheticcredentialvalue`};',
    'const headers = {Authorization: `Bearer ${({value:"syntheticcredentialvalue"}).value}`};',
    'const headers = {Authorization: `Bearer ${["syntheticcredentialvalue"][0]}`};',
    '// Authorization: Bearer syntheticcredentialvalue',
    'const headers = { apiKey: "syntheticcredentialvalue" };',
  ]) assert.equal(scan(source), true, source);
  for (const path of ["src/atlas-embeddings.ts", "src/factory-droid.ts", "src/factory-model.ts", "src/decision-models.ts"]) assert.equal(scan(readFileSync(path, "utf8")), false, path);
});

test("release home-path scan distinguishes logical root suffixes from filesystem paths", async () => {
  const { maskSourceLogicalRoots } = await import(pathToFileURL(resolve("scripts/release-source-scan.mjs")).href);
  const logical = 'function scope(session, parent, fallback) { return `${session ? `session:${session}` : `document:${fallback}`}${parent ? `/parent-tool:${parent}` : "/root"}`; }';
  const scan = (source: string) => containsPortableLocalHomePath(maskSourceLogicalRoots(source, "fixture.ts", ts));
  assert.equal(containsPortableLocalHomePath(logical), true);
  assert.equal(scan(logical), false);
  assert.equal(scan(readFileSync("src/v2-profiles/claude.ts", "utf8")), false);
  assert.equal(scan(readFileSync("dist/src/v2-profiles/claude.js", "utf8")), false);
  for (const source of [
    'const cwd = "/root";',
    'const cwd = "/root/private";',
    'const cwd = `/root/${name}`;',
    'const suffix = parent ? `/parent-tool:${parent}` : "/root";',
    logical.replace('"/root"', '"/root/private"'),
    logical.replace('`document:${fallback}`', '`file:${fallback}`'),
    logical + ' const cwd = "/Users/alice";',
    logical.replace('`session:${session}`', '`session:${"/Users/alice"}`'),
  ]) assert.equal(scan(source), true, source);
  assert.equal(containsPortableLocalHomePath("/root"), true, "the data export policy retains its home-path boundary");
  const credential = logical + ' const headers = {Authorization: "Bearer syntheticcredentialvalue"};';
  assert.equal(containsPortableSecretPattern(maskSourceLogicalRoots(credential, "fixture.ts", ts), "text/plain"), true);
});

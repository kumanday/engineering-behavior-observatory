import { createHash } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { listRuntimeRecipes } from "../src/runtime-catalog.js";
import { ANTIGRAVITY_CLI_VERSION } from "../src/antigravity.js";
import type { StudyRuntimeOptions } from "../src/study-runtimes.js";

/** Authored publisher I/O and installation; no network, credentials or model inference. */
export function fakeAntigravityRuntimeOptions(cliFallback?: string): StudyRuntimeOptions {
  const archive = Buffer.from("Authored Antigravity archive fixture"), sha = createHash("sha256").update(archive).digest("hex");
  const asset = listRuntimeRecipes().find(r => r.id === "antigravity-cli")!.components[0]!.assetPattern!.includes("mac") ? "mac" : "linux";
  const name = `agy_cli_${asset}_${process.arch === "x64" ? "x64" : process.arch}.tar.gz`;
  const locator = `https://github.com/google-antigravity/antigravity-cli/releases/download/${ANTIGRAVITY_CLI_VERSION}/${name}`;
  return { now: () => "2026-11-17T12:00:00Z", query: async () => ({}), fetch: async url => {
    if (url.includes("/attestations/")) return new Response("", {status: 404});
    if (url === locator) return new Response(archive);
    if (url.includes("/releases?")) return Response.json([{tag_name: ANTIGRAVITY_CLI_VERSION, published_at: "2026-11-14T05:39:50Z", assets: [{name, browser_download_url: locator, digest: `sha256:${sha}`}]}]);
    throw new Error(`Unexpected fixture request: ${url}`);
  }, run: async (_command, args, cwd) => {
    if (args.includes("-c")) {
      const directory = join(cwd, "runtime"); await mkdir(directory, {recursive: true});
      const file = cliFallback ?? fileURLToPath(new URL("../../test/fixtures/antigravity/fake-agy.mjs", import.meta.url));
      const path = join(directory, "antigravity");
      await writeFile(path, `#!${process.execPath}\nimport {pathToFileURL} from 'node:url';
const args=process.argv.slice(2);
if(args.includes('--version')){console.log('${ANTIGRAVITY_CLI_VERSION}');process.exit(0);}
if(args.includes('--help')){console.log('--input-format --output-format --print-timeout');process.exit(0);}
const file=args[0]?.endsWith('.mjs')?args.shift():${JSON.stringify(file)};
process.argv=[process.execPath,file,...args];await import(pathToFileURL(file).href);\n`);
      await chmod(path, 0o700);
    }
    return {code: 0, stdout: "", stderr: ""};
  }};
}

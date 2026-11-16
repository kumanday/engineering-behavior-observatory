import { createHash } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { listRuntimeRecipes } from "../src/runtime-catalog.js";
import type { StudyRuntimeOptions } from "../src/study-runtimes.js";

export function fakeVendorRuntimeOptions(cliFallback?: string): StudyRuntimeOptions {
  const version = "3000.11.3", archive = Buffer.from("Authored Devin runtime archive fixture");
  const sha = createHash("sha256").update(archive).digest("hex");
  const platform = listRuntimeRecipes().find((recipe) => recipe.id === "devin-cli")!.components[0]!.platform!;
  const locator = `https://static.devin.ai/cli/${version}/fixture.tar.gz`;
  return { now: () => "2026-11-07T12:00:00Z", query: async () => ({}), fetch: async (url) => {
    if (url.includes("/attestations/")) return new Response("", {status: 404});
    if (url === locator) return new Response(archive);
    return new Response(JSON.stringify(url.includes("api.github.com") ? [{tag_name: `v${version}`, published_at: "2026-11-05T00:00:00Z", draft: false, prerelease: false}] : {platforms: {[platform]: {url: locator, sha256: sha}}}));
  }, run: async (_command, args, cwd) => {
    if (args.includes("-c")) {
      const bin = join(cwd, "runtime", "bin"); await mkdir(bin, {recursive: true});
      const executable = join(bin, "devin"), file = cliFallback ?? fileURLToPath(new URL("../../test/fixtures/devin/fake-acp-server.mjs", import.meta.url));
      await writeFile(executable, `#!${process.execPath}\nimport {pathToFileURL} from 'node:url';\nconst args=process.argv.slice(2);if(args.includes('--version')){console.log('devin ${version}');process.exit(0);}const file=args[0]?.endsWith('.mjs')?args.shift():${JSON.stringify(file)};process.argv=[process.execPath,file,...args];await import(pathToFileURL(file).href);\n`);
      await chmod(executable, 0o700);
    }
    return {code: 0, stdout: "", stderr: ""};
  }};
}

import {createHash} from "node:crypto";
import {mkdir, writeFile} from "node:fs/promises";
import {join} from "node:path";
import type {StudyRuntimeOptions} from "../src/study-runtimes.js";

/** External registry/command fixtures; no package or Python implementation is executed. */
export function fakePythonRuntimeOptions(): StudyRuntimeOptions {
  const versions: Record<string, string> = {harbor: "0.25.0", smolmachines: "1.26.1"};
  const bytes = Buffer.from("authored wheel command fixture"), sha = createHash("sha256").update(bytes).digest("hex");
  const file = (name: string) => ({filename: `${name}-${versions[name]}-py3-none-any.whl`, url: `https://files.pythonhosted.org/${name}.whl`, upload_time_iso_8601: "2026-11-05T00:00:00Z", digests: {sha256: sha}, yanked: false});
  let names: string[] = [];
  const bootstrap = {schemaVersion: "ebo.python-bootstrap/v1", executable: "/python", version: "3.13.1", abi: "cpython-313-fixture", platform: process.platform, architecture: process.arch, binaryIntegrity: `sha256-${Buffer.alloc(32).toString("base64")}`};
  return {now: () => "2026-11-07T12:00:00Z", query: async () => ({}), fetch: async (url) => {
    if (url.endsWith(".whl")) return new Response(bytes);
    const name = /\/(?:pypi|simple)\/([^/]+)/u.exec(url)?.[1]!;
    return Response.json(url.includes("/simple/") ? {files: [file(name)]} : {releases: {[versions[name]!]: [file(name)]}, urls: [file(name)]});
  }, run: async (_command, args) => {
    if (args.includes("ebo-package-versions")) return {code: 0, stdout: JSON.stringify(Object.fromEntries(args.slice(args.indexOf("ebo-package-versions") + 1).map((name) => [name, versions[name]]))), stderr: ""};
    if (args.includes("-c")) return {code: 0, stdout: JSON.stringify(bootstrap), stderr: ""};
    if (args.includes("--output-file")) {
      const {readFile} = await import("node:fs/promises");
      names = (await readFile(args[2]!, "utf8")).trim().split("\n").map((line) => line.split("==")[0]!);
      await writeFile(args[args.indexOf("--output-file") + 1]!, names.map((name) => `${name}==${versions[name]} --hash=sha256:${sha}`).join("\n"));
    }
    if (args.includes("--report")) await writeFile(args[args.indexOf("--report") + 1]!, JSON.stringify({install: names.map((name) => ({metadata: {name, version: versions[name]}, download_info: {url: file(name).url, archive_info: {hashes: {sha256: sha}}}}))}));
    if (args.includes("venv")) {const bin = join(args.at(-1)!, "bin"); await mkdir(bin, {recursive: true}); await writeFile(join(bin, "python"), "authored interpreter command fixture\n");}
    return {code: 0, stdout: "", stderr: ""};
  }};
}

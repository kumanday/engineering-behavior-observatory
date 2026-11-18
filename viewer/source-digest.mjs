// The digest of the viewer's sources, stamped into viewer/dist/build-stamp.json at build time. `ebo atlas serve` and
// `ebo packet build` recompute it in a source checkout (src/atlas-viewer.ts, `viewerSourceDigest`, follows the same
// rule) and warn when viewer/dist was built from other sources.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export const VIEWER_SOURCE_INPUTS = ["index.html", "package.json", "vite.config.ts", "source-digest.mjs", "src"];

export function viewerSourceDigest(viewerDir) {
  const files = [];
  const walk = (path) => {
    if (statSync(path).isDirectory()) { for (const name of readdirSync(path)) walk(join(path, name)); return; }
    files.push(relative(viewerDir, path).split(sep).join("/"));
  };
  for (const input of VIEWER_SOURCE_INPUTS) walk(join(viewerDir, input));
  const hash = createHash("sha256");
  for (const file of files.sort()) hash.update(`${file}\0`).update(readFileSync(join(viewerDir, file))).update("\0");
  return `sha256:${hash.digest("hex")}`;
}

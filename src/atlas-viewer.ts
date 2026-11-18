import { createHash } from "node:crypto";
import { createReadStream, existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The built Atlas viewer (`viewer/dist`, shipped in the npm package) and the local server that shows one Atlas bundle
 * with it: the viewer at `/`, the bundle's files at `/bundle/`. Read-only, loopback only, no directory listings, and
 * every path must resolve inside its root after symlinks.
 */
export const ATLAS_VIEWER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "viewer", "dist");

/** The viewer source files the build stamp covers; `viewer/source-digest.mjs` holds the same list and rule. */
const VIEWER_SOURCE_INPUTS = ["index.html", "package.json", "vite.config.ts", "source-digest.mjs", "src"];

/** Digest of the viewer sources under `viewerDir`, as `viewer/source-digest.mjs` computes it at build time. */
export function viewerSourceDigest(viewerDir: string): `sha256:${string}` {
  const files: string[] = [];
  const walk = (path: string): void => {
    if (statSync(path).isDirectory()) { for (const name of readdirSync(path)) walk(join(path, name)); return; }
    files.push(relative(viewerDir, path).split(sep).join("/"));
  };
  for (const input of VIEWER_SOURCE_INPUTS) walk(join(viewerDir, input));
  const hash = createHash("sha256");
  for (const file of files.sort()) hash.update(`${file}\0`).update(readFileSync(join(viewerDir, file))).update("\0");
  return `sha256:${hash.digest("hex")}`;
}

/**
 * Whether the built viewer matches the sources beside it. An installed package ships the build without its sources,
 * so there is nothing to compare ("packaged"). In a source checkout, a build stamped from other sources is "stale" and
 * a build without a stamp is "unstamped"; both return the warning to show.
 */
export function atlasViewerFreshness(viewerRoot = ATLAS_VIEWER_ROOT): { status: "current" | "stale" | "unstamped" | "packaged"; warning?: string } {
  const viewerDir = dirname(viewerRoot);
  if (!existsSync(join(viewerDir, "src", "main.ts")) || !existsSync(join(viewerDir, "index.html"))) return { status: "packaged" };
  let stamped: unknown;
  try { stamped = (JSON.parse(readFileSync(join(viewerRoot, "build-stamp.json"), "utf8")) as { sourceDigest?: unknown }).sourceDigest; } catch { stamped = undefined; }
  if (typeof stamped !== "string") return { status: "unstamped", warning: `Warning: the Atlas viewer in ${viewerRoot} has no build stamp, so it may be older than the viewer sources; run npm run build:viewer.` };
  if (stamped !== viewerSourceDigest(viewerDir)) return { status: "stale", warning: `Warning: the Atlas viewer in ${viewerRoot} was built from other sources than the checkout's; run npm run build:viewer.` };
  return { status: "current" };
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".wasm": "application/wasm", ".arrow": "application/vnd.apache.arrow.stream",
  ".svg": "image/svg+xml", ".png": "image/png", ".parquet": "application/vnd.apache.parquet", ".txt": "text/plain; charset=utf-8",
};
const LOOPBACK = ["127.0.0.1", "localhost", "[::1]"];

/** A file under `root` for a URL path, or undefined when it escapes the root, does not exist or is not a file. */
export function resolveContained(root: string, urlPath: string): string | undefined {
  let decoded: string;
  try { decoded = decodeURIComponent(urlPath); } catch { return undefined; }
  if (decoded.includes("\0") || decoded.split("/").some((part) => part === "..")) return undefined;
  const realRoot = realpathSync(root);
  const candidate = resolve(realRoot, `.${decoded.startsWith("/") ? decoded : `/${decoded}`}`);
  if (!existsSync(candidate)) return undefined;
  const real = realpathSync(candidate);
  if (real !== realRoot && !real.startsWith(realRoot + sep)) return undefined;
  return statSync(real).isFile() ? real : undefined;
}

export async function serveAtlasBundle(bundleRoot: string, port = 13012, viewerRoot = ATLAS_VIEWER_ROOT): Promise<Server> {
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error("Invalid Atlas port.");
  if (!existsSync(join(viewerRoot, "index.html"))) throw new Error(`The Atlas viewer is not built (${viewerRoot}); run npm run build:viewer.`);
  if (!existsSync(join(bundleRoot, "units.arrow"))) throw new Error(`${bundleRoot} is not an Atlas bundle (units.arrow is missing).`);
  const server = createServer((req, res) => {
    res.setHeader("Cache-Control", "no-store"); res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Referrer-Policy", "no-referrer");
    try {
      if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405).end(); return; }
      if (!req.headers.host || !LOOPBACK.includes(new URL(`http://${req.headers.host}`).hostname)) { res.writeHead(403).end(); return; }
      if (req.headers.origin && !LOOPBACK.includes(new URL(req.headers.origin).hostname)) { res.writeHead(403).end(); return; }
      const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      const file = path.startsWith("/bundle/") ? resolveContained(bundleRoot, path.slice("/bundle".length))
        : resolveContained(viewerRoot, path === "/" ? "/index.html" : path);
      if (file === undefined) { res.writeHead(404).end(); return; }
      res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream", "Content-Length": statSync(file).size });
      if (req.method === "HEAD") { res.end(); return; }
      createReadStream(file).pipe(res);
    } catch { res.writeHead(400).end(); }
  });
  await new Promise<void>((accept, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", accept); });
  return server;
}

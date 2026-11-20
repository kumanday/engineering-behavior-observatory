import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, existsSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, statSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { redactSecrets } from "./redaction.js";

/**
 * Unit embeddings for the Atlas cloud. The bundle carries one vector per embedded unit, in cloud row order.
 *
 * The default provider is EmbeddingGemma 2 (`google/embeddinggemma-2` at a pinned revision), run locally through
 * SentenceTransformers in the pinned Python runtime of `scripts/embeddings/requirements.txt`, on CUDA, MPS or CPU.
 * Each text gets the model card's clustering prompt; the published graph mean-pools and L2-normalizes, and a
 * requested truncation (512, 256 or 128 of the native 768 dimensions) is normalized again. Only `embed_text` is
 * embedded (behavior summaries and capped message text, never tool output or file contents), with secrets redacted
 * first. Vectors are cached per (model, revision, dimensions, redacted text digest).
 *
 * Hashed TF-IDF over the units' words is an explicit offline option (`hashed-tfidf`): no runtime and no model.
 */
export type EmbeddingProvider = "embeddinggemma" | "hashed-tfidf";
export type EmbeddingConfig = {
  provider: EmbeddingProvider; model: string; revision?: string; dimensions: number; cache: string;
  /** The runtime's Python executable (`embeddings.python` in the request, else EBO_EMBEDDINGS_PYTHON). */
  python?: string; device?: "auto" | "cuda" | "mps" | "cpu"; batchSize?: number;
  /** Where the cloud is laid out: in the browser from the vectors, at build time in the runtime, or `auto` by size. */
  layout: "auto" | "browser" | "build";
};
/** What the build-time layout reports: the backend that ran (cuML on CUDA, else umap-learn on the CPU) and its timings. */
export type LayoutRun = { backend: string; backendVersion: string; device: string; units: number; pca: number; neighbors: number; minDist: number; seed: number; metric: string;
  familySeconds: Record<string, number>; packages: Record<string, string>; seconds?: number };
/** Above this many cloud units the layout is computed at build time when the runtime is available (`layout: "auto"`). */
export const BUILD_LAYOUT_UNITS = 200_000;
export const LAYOUT_SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "embeddings", "layout.py");
/** What the embedding runtime reports about one run. */
export type EmbeddingRuntime = { device: string; deviceName?: string; dtype: string; batchSize: number; textsPerSecond: number | null; seconds: number;
  promptName: string; prompt: string | null; packages: Record<string, string>; warning?: string };
/** What one embedding pass did, recorded in the bundle manifest. */
export type EmbeddingRun = { texts: number; distinct: number; cached: number; embedded: number; seconds: number; runtime?: EmbeddingRuntime };
export type EmbeddingOptions = { command?: readonly string[]; progress?: (line: string) => void };

export const EMBEDDINGGEMMA_MODEL = "google/embeddinggemma-2";
/** The model revision EBO's prompt, pooling and dimensions were checked against. */
export const EMBEDDINGGEMMA_REVISION = "f9972ac22e696a105c482202646979e33e4b5a1e";
export const EMBEDDINGGEMMA_DIMENSIONS = [768, 512, 256, 128] as const;
export const EMBEDDINGGEMMA_PROMPT_NAME = "Clustering";
export const LOCAL_EMBEDDING_MODEL = "ebo-hashed-tfidf-1";
export const EMBEDDING_SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "embeddings", "embed.py");

export type EmbeddingRequest = { provider?: EmbeddingProvider; model?: string; revision?: string; dimensions?: number; cache?: string; python?: string;
  device?: EmbeddingConfig["device"]; batchSize?: number; layout?: EmbeddingConfig["layout"] };

/** The provider, model and dimensions a bundle request selects, with EmbeddingGemma 2 at 768 dimensions by default. */
export function embeddingConfig(request: EmbeddingRequest | undefined, base: string, env: NodeJS.ProcessEnv = process.env): EmbeddingConfig {
  const provider = request?.provider ?? "embeddinggemma";
  const cache = resolve(base, request?.cache ?? ".atlas-cache/embeddings");
  const python = request?.python ? resolve(base, request.python) : env.EBO_EMBEDDINGS_PYTHON;
  const layout = request?.layout ?? "auto";
  if (layout === "build" && !python) throw new Error("A build-time layout needs the Python runtime: set embeddings.python in the bundle request or EBO_EMBEDDINGS_PYTHON.");
  if (provider === "hashed-tfidf") return { provider, model: LOCAL_EMBEDDING_MODEL, dimensions: request?.dimensions ?? 256, cache, layout, ...(python ? { python } : {}) };
  const dimensions = request?.dimensions ?? 768;
  if (!(EMBEDDINGGEMMA_DIMENSIONS as readonly number[]).includes(dimensions)) throw new Error(`EmbeddingGemma 2 embeddings have ${EMBEDDINGGEMMA_DIMENSIONS.join(", ")} dimensions; ${dimensions} was requested.`);
  return { provider, model: request?.model ?? EMBEDDINGGEMMA_MODEL, revision: request?.revision ?? EMBEDDINGGEMMA_REVISION, dimensions, cache, layout,
    ...(python ? { python } : {}), device: request?.device ?? "auto", ...(request?.batchSize ? { batchSize: request.batchSize } : {}) };
}

const words = (text: string) => text.toLowerCase().match(/`[^`]{1,60}`|[a-z][a-z0-9_./:-]{1,40}/gu) ?? [];
const fnv = (s: string) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; };

/** Hashed TF-IDF: each text's word weights, feature-hashed (signed) into `dimensions`, L2-normalized. */
export function localEmbeddings(texts: readonly string[], dimensions: number): Float32Array {
  const df = new Map<string, number>();
  const tokenized = texts.map((t) => { const w = words(t); for (const x of new Set(w)) df.set(x, (df.get(x) ?? 0) + 1); return w; });
  const out = new Float32Array(texts.length * dimensions);
  tokenized.forEach((w, i) => {
    const tf = new Map<string, number>();
    for (const x of w) tf.set(x, (tf.get(x) ?? 0) + 1);
    let norm = 0;
    for (const [x, n] of tf) {
      const h = fnv(x), slot = h % dimensions, sign = h & 0x80000000 ? -1 : 1;
      const weight = (1 + Math.log(n)) * Math.log((1 + texts.length) / (1 + df.get(x)!)) * sign;
      out[i * dimensions + slot]! += weight;
    }
    for (let j = 0; j < dimensions; j++) norm += out[i * dimensions + j]! ** 2;
    norm = Math.sqrt(norm) || 1;
    for (let j = 0; j < dimensions; j++) out[i * dimensions + j]! /= norm;
  });
  return out;
}

/**
 * An append-only vector cache: `keys.bin` holds the 32-byte SHA-256 of each redacted text and `vectors.f32` its
 * vector, row for row. Vectors are appended before their keys, so an interrupted write leaves only whole entries.
 */
class VectorCache {
  readonly rows = new Map<string, number>();
  private readonly keys: string; private readonly vectors: string;
  constructor(directory: string, private readonly dimensions: number) {
    mkdirSync(directory, { recursive: true });
    this.keys = join(directory, "keys.bin"); this.vectors = join(directory, "vectors.f32");
    if (!existsSync(this.keys) || !existsSync(this.vectors)) return;
    const keys = readFileSync(this.keys), whole = Math.min(Math.floor(keys.length / 32), Math.floor(statSync(this.vectors).size / (4 * dimensions)));
    for (let row = 0; row < whole; row++) this.rows.set(keys.toString("hex", row * 32, row * 32 + 32), row);
  }
  /** Copies cached rows into the given views with positioned reads on one handle. */
  read(requests: ReadonlyArray<{ row: number; into: Float32Array }>): void {
    if (!requests.length) return;
    const fd = openSync(this.vectors, "r"), bytes = 4 * this.dimensions;
    try {
      for (const { row, into } of requests) readSync(fd, new Uint8Array(into.buffer, into.byteOffset, bytes), 0, bytes, row * bytes);
    } finally { closeSync(fd); }
  }
  append(keys: readonly Buffer[], vectors: Buffer): void {
    const first = this.rows.size, aligned = first * 4 * this.dimensions;
    // An interrupted earlier append may have left vector bytes past the last key: drop them first.
    if (existsSync(this.vectors) && statSync(this.vectors).size !== aligned) {
      const fd = openSync(this.vectors, "r+");
      try { ftruncateSync(fd, aligned); } finally { closeSync(fd); }
    }
    if (existsSync(this.keys) && statSync(this.keys).size !== first * 32) {
      const fd = openSync(this.keys, "r+");
      try { ftruncateSync(fd, first * 32); } finally { closeSync(fd); }
    }
    appendFileSync(this.vectors, vectors);
    appendFileSync(this.keys, Buffer.concat(keys));
    keys.forEach((key, i) => this.rows.set(key.toString("hex"), first + i));
  }
}

/** Runs the pinned runtime over `inputPath` (JSON lines), relaying its progress, and returns its stats. */
async function runEmbedder(config: EmbeddingConfig, inputPath: string, outputPath: string, statsPath: string, options: EmbeddingOptions): Promise<EmbeddingRuntime> {
  const args = ["--model", config.model, "--revision", config.revision!, "--dimensions", String(config.dimensions), "--prompt-name", EMBEDDINGGEMMA_PROMPT_NAME,
    "--device", config.device ?? "auto", "--batch-size", String(config.batchSize ?? 0), "--input", inputPath, "--output", outputPath, "--stats", statsPath];
  const command = options.command ?? (config.python ? [config.python, "-I", EMBEDDING_SCRIPT] : undefined);
  if (!command) throw new Error("EmbeddingGemma 2 needs its Python runtime: set embeddings.python in the bundle request or EBO_EMBEDDINGS_PYTHON (install it from scripts/embeddings/requirements.txt), or choose the offline provider \"hashed-tfidf\" explicitly.");
  await runRuntime(command, args, options);
  return JSON.parse(readFileSync(statsPath, "utf8")) as EmbeddingRuntime;
}

/**
 * Lays out the cloud at build time: per unit family, PCA to 128 dimensions and cosine UMAP (15 neighbors, minimum
 * distance 0.1, seed 42) in the runtime, with cuML on CUDA or umap-learn on the CPU. Returns each row's position and
 * neighbors, in cloud row order.
 */
export async function layoutCloud(embeddingsPath: string, dimensions: number, families: readonly string[], config: EmbeddingConfig,
  options: { command?: readonly string[]; progress?: (line: string) => void } = {}): Promise<{ xy: Float32Array; neighborIds: Int32Array; neighborDistances: Float32Array; k: number; run: LayoutRun }> {
  const command = options.command ?? (config.python ? [config.python, "-I", LAYOUT_SCRIPT] : undefined);
  if (!command) throw new Error("A build-time layout needs the Python runtime: set embeddings.python in the bundle request or EBO_EMBEDDINGS_PYTHON.");
  const scratch = mkdtempSync(join(dirname(resolve(embeddingsPath)), ".layout-"));
  try {
    const familiesPath = join(scratch, "families.jsonl"), output = join(scratch, "layout.bin"), stats = join(scratch, "stats.json"), k = 15;
    const fd = openSync(familiesPath, "w");
    try { for (let i = 0; i < families.length; i += 65536) writeSync(fd, families.slice(i, i + 65536).map((f) => `${JSON.stringify(f)}\n`).join("")); } finally { closeSync(fd); }
    const started = performance.now();
    await runRuntime(command, ["--embeddings", embeddingsPath, "--dimensions", String(dimensions), "--families", familiesPath, "--output", output, "--stats", stats,
      "--neighbors", String(k)], options);
    const bytes = readFileSync(output), n = families.length;
    if (bytes.length !== n * (8 + 8 * k)) throw new Error(`The layout runtime wrote ${bytes.length} bytes for ${n} units.`);
    const copy = (offset: number, length: number) => bytes.buffer.slice(bytes.byteOffset + offset, bytes.byteOffset + offset + length);
    return { xy: new Float32Array(copy(0, n * 8)), neighborIds: new Int32Array(copy(n * 8, n * 4 * k)), neighborDistances: new Float32Array(copy(n * 8 + n * 4 * k, n * 4 * k)), k,
      run: { ...(JSON.parse(readFileSync(stats, "utf8")) as LayoutRun), seconds: Math.round((performance.now() - started) / 100) / 10 } };
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

/** Runs one runtime command to completion, relaying its stderr lines and failing with their tail. */
async function runRuntime(command: readonly string[], args: readonly string[], options: { progress?: (line: string) => void }): Promise<void> {
  const tail: string[] = [];
  await new Promise<void>((accept, reject) => {
    const child = spawn(command[0]!, [...command.slice(1), ...args], { stdio: ["ignore", "ignore", "pipe"] });
    let pending = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop()!;
      for (const line of lines) { tail.push(line); if (tail.length > 40) tail.shift(); options.progress?.(line); }
    });
    child.once("error", reject);
    child.once("close", (code) => (code === 0 ? accept()
      : reject(new Error(`The embedding runtime exited with ${String(code)}: ${redactSecrets([...tail, pending].join("\n").slice(-2000)).text}`))));
  });
}

/**
 * Embeds `texts` into `outputPath` (float32, one row per text in order) and reports the pass. Distinct texts missing
 * from the cache go to the runtime once; every row is then read from the cache in blocks, so memory is bounded by
 * the distinct-text index, not by the cloud's vectors.
 */
export async function embedTexts(texts: readonly string[], config: EmbeddingConfig, outputPath: string, options: EmbeddingOptions = {}): Promise<EmbeddingRun> {
  const started = performance.now();
  if (config.provider === "hashed-tfidf") {
    const vectors = localEmbeddings(texts, config.dimensions), fd = openSync(outputPath, "w");
    try { writeSync(fd, new Uint8Array(vectors.buffer, vectors.byteOffset, vectors.byteLength)); } finally { closeSync(fd); }
    return { texts: texts.length, distinct: new Set(texts).size, cached: 0, embedded: texts.length, seconds: (performance.now() - started) / 1000 };
  }
  const key = createHash("sha256").update(`${config.provider}\0${config.model}\0${config.revision ?? ""}\0${config.dimensions}`).digest("hex").slice(0, 16);
  const cache = new VectorCache(join(config.cache, key), config.dimensions);
  // Output row i is the vector of distinct text slot[i]; what reaches the runtime is the redacted text.
  const slotOf = new Map<string, number>(), slot = new Int32Array(texts.length), distinct: Array<{ text: string; key: Buffer; hex: string }> = [];
  texts.forEach((raw, i) => {
    const text = redactSecrets(raw).text, digest = createHash("sha256").update(text).digest(), hex = digest.toString("hex");
    let s = slotOf.get(hex);
    if (s === undefined) { s = distinct.length; slotOf.set(hex, s); distinct.push({ text, key: digest, hex }); }
    slot[i] = s;
  });
  slotOf.clear();
  const missing = distinct.filter(({ hex }) => !cache.rows.has(hex));
  let runtime: EmbeddingRuntime | undefined;
  if (missing.length) {
    const scratch = mkdtempSync(join(dirname(resolve(outputPath)), ".embeddings-"));
    try {
      const input = join(scratch, "texts.jsonl"), vectors = join(scratch, "vectors.f32"), stats = join(scratch, "stats.json");
      const fd = openSync(input, "w");
      try { for (const { text } of missing) writeSync(fd, `${JSON.stringify(text)}\n`); } finally { closeSync(fd); }
      runtime = await runEmbedder(config, input, vectors, stats, options);
      const bytes = readFileSync(vectors);
      if (bytes.length !== missing.length * 4 * config.dimensions) throw new Error(`The embedding runtime wrote ${bytes.length / (4 * config.dimensions)} vectors for ${missing.length} texts.`);
      cache.append(missing.map(({ key: k }) => k), bytes);
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  }
  const rowOf = Int32Array.from(distinct, ({ hex }) => cache.rows.get(hex)!);
  const d = config.dimensions, block = 8192, fd = openSync(outputPath, "w");
  try {
    for (let start = 0; start < texts.length; start += block) {
      const n = Math.min(block, texts.length - start), out = new Float32Array(n * d);
      cache.read(Array.from({ length: n }, (_, j) => ({ row: rowOf[slot[start + j]!]!, into: out.subarray(j * d, (j + 1) * d) })));
      writeSync(fd, new Uint8Array(out.buffer));
    }
  } finally { closeSync(fd); }
  return { texts: texts.length, distinct: distinct.length, cached: distinct.length - missing.length, embedded: missing.length,
    seconds: (performance.now() - started) / 1000, ...(runtime ? { runtime } : {}) };
}

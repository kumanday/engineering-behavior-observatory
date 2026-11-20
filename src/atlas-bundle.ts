import { operationAlias } from "./event-aliases.js";
import { retainedContentResolver as contentResolver } from "./retained-content.js";
import { createHash } from "node:crypto";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { closeSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { finished } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";

import { digestMetadata, validateArtifact } from "./artifacts.js";
import { behaviorMembers, readAggregationAssertions, type AggregationRequest } from "./aggregation.js";
export { ownPointer } from "./retained-content.js";
import { loadAtlas, queryAtlas, type AtlasSource, type AtlasView } from "./atlas.js";
import { Bool, Dictionary, Field, Float32, Float64, Int32, List, makeData, makeVector, RecordBatchStreamWriter, Struct, Table, Utf8, vectorFromArray } from "apache-arrow";
import { clusterCloud, FacetIndex } from "./atlas-clusters.js";
import { buildViews, validateClaims, type ClaimsSource } from "./atlas-claims.js";
import { BUILD_LAYOUT_UNITS, checkEmbeddingRuntime, embeddingConfig as selectEmbeddings, embedTexts, layoutCloud, type EmbeddingOptions, type EmbeddingProvider, type EmbeddingRequest, type EmbeddingRun, type LayoutRun } from "./atlas-embeddings.js";
import { assessmentDoc, attemptEvidence, NativeLines, nativeRecordDigest } from "./atlas-evidence.js";
import { laneData, type LaneMeta } from "./atlas-lanes.js";
import { ATLAS_UNITS_VERSION, clipText, deriveUnits, type AtlasUnit } from "./atlas-units.js";
import { BEHAVIOR_PRODUCER_MODES, isDecisionModelAssertion, producerLabel, type BehaviorAssertion } from "./behavior-assertions.js";
import { BEHAVIOR_DIRECTIONS, BEHAVIOR_VERDICTS, behaviorDirection, loadDefaultBehaviorOntology, resolveBehaviorCard } from "./behavior-ontology.js";
import type { CorpusIndexEntry } from "./corpus.js";
import { readLeaderboardCohort } from "./leaderboard-import.js";
import { createRetainedBehaviorEvidence, withRetainedEvidenceReuse, type RetainedEvidenceReuseStats } from "./retained-evidence.js";
import { validationWorkers } from "./workers.js";
import { withCorpusValidationReuse } from "./corpus.js";
import type { StructuralObservationSet } from "./structural-observations.js";
import type { UniformEvent } from "./uniform-events.js";

/**
 * Atlas bundles (ebo.atlas-bundle/v2): the analytical tables behind the Atlas viewer, built from validated EBO
 * artifacts. Every cohort is loaded through the same validation as `ebo atlas build` (corpus index, observation sets,
 * assertions, citations, reviews); each attempt's retained evidence is read once. Native records stay authoritative:
 * event text is a flattened view of resolved native content for search and embedding, never a replacement.
 */
export const ATLAS_BUNDLE_BUILDER = { id: "ebo-atlas-bundle", version: "2.0.0" } as const;
export const ATLAS_TABLES_VERSION = "1.0.0";

export type AtlasBundleRequest = {
  schemaVersion: "ebo.atlas-bundle-request/v2";
  /** Stable study identifier, used in claim and bundle identities. */
  id: string;
  title: string;
  /** Cohorts by their Atlas requests (each names an aggregation request). Paths are relative to this request. */
  cohorts: ReadonlyArray<{ id: string; atlasRequest: string }>;
  /** Verified source labels for matching imports. The store is relative to this request. */
  leaderboard?: { store: string; cohortId: `sha256:${string}` };
  /** Study arms: a regular expression over each run bundle's directory name with a named group `condition`. */
  condition?: { pattern: string };
  /** Study-authored claims (validated, never generated) and a directory of view specs. */
  claims?: string;
  views?: string;
  /**
   * Unit embeddings for the cloud: EmbeddingGemma 2 at 768 dimensions by default, run locally in the pinned Python
   * runtime (`python`, else EBO_EMBEDDINGS_PYTHON); `hashed-tfidf` is the offline option. See atlas-embeddings.ts.
   */
  embeddings?: EmbeddingRequest;
};

export type AtlasBundleManifest = {
  schemaVersion: "ebo.atlas-bundle/v2";
  id: string;
  title: string;
  builder: typeof ATLAS_BUNDLE_BUILDER;
  tablesVersion: typeof ATLAS_TABLES_VERSION;
  createdAt: string;
  request: { digest: `sha256:${string}` };
  cohorts: Array<{ id: string; title: string; sourceDigest: string; cohortDigest: string; attempts: number; assertions: number; report: string }>;
  unitsVersion: typeof ATLAS_UNITS_VERSION;
  /** A packet's shared copy of a bundle names the bundle it was derived from and the variant. */
  derivedFrom?: { bundle: string; manifestSha256: `sha256:${string}`; variant: "partner" | "restricted" };
  /** The cloud's units and their embeddings; the viewer lays them out with Embedding Atlas (UMAP and clustering). */
  cloud: { units: number; embeddings: { file: string; provider: EmbeddingProvider; model: string; revision?: string; dimensions: number; run?: EmbeddingRun };
    /** Where the cloud was laid out: at build time (units.arrow carries x, y and neighbors) or in the viewer from the vectors. */
    layout?: { where: "build" | "browser"; run?: LayoutRun; compact?: boolean } };
  tables: Record<string, { path: string; rows: number; sha256: `sha256:${string}` }>;
  files: Array<{ path: string; bytes: number; sha256: `sha256:${string}`; role: string }>;
};

type Row = Record<string, string | number | boolean | null | string[]>;

/** A UUID or hex id reads by its first eight characters; any other id (a leaderboard trial name) reads whole. */
export function shortAttemptId(id: string): string {
  return /^[0-9a-f]{8}(?:-?[0-9a-f]{4,})+$/iu.test(id) || /^[0-9a-f]{16,}$/iu.test(id) ? id.slice(0, 8) : id;
}
type Column = [name: string, type: "VARCHAR" | "BIGINT" | "DOUBLE" | "BOOLEAN" | "VARCHAR[]"];
const S = "VARCHAR", I = "BIGINT", F = "DOUBLE", B = "BOOLEAN", L = "VARCHAR[]";

/** Atlas tables v1: the lab's P0 tables plus occurrences. Column order is part of the contract. */
export const ATLAS_TABLES: Record<string, Column[]> = {
  cohorts: [["cohort_id", S], ["title", S], ["atlas_request", S], ["report_mode", S], ["cohort_digest", S], ["source_digest", S],
    ["report_generated_at", S], ["source_attempts", I], ["matching_cases", I], ["group_by", S], ["operator_narrative", S]],
  attempts: [["attempt_id", S], ["run_id", S], ["bundle_id", S], ["model_id", S], ["model_route", S], ["model_provider", S], ["harness_id", S], ["harness_version", S],
    ["task_id", S], ["fixture_id", S], ["trial_id", S], ["condition", S], ["assessment_mode", S], ["capture_qualification", S], ["terminal_state", S],
    ["failure_class", S], ["stop_reason", S], ["adapter_id", S], ["adapter_version", S], ["dataset_digest", S], ["manifest_digest", S],
    ["bundle_root", S], ["event_count", I], ["native_record_count", I], ["unmapped_record_count", I], ["first_event_time", S],
    ["last_event_time", S], ["native_span_seconds", F], ["source_outcome", S], ["source_outcome_source", S], ["source_outcome_release", S],
    ["source_outcome_record", S]],
  attempt_cohorts: [["attempt_id", S], ["cohort_id", S]],
  events: [["event_key", S], ["event_id", S], ["attempt_id", S], ["run_id", S], ["dataset_index", I], ["family", S], ["phase", S], ["actor_kind", S],
    ["actor_id", S], ["scope_kind", S], ["scope_id", S], ["harness", S], ["native_type", S], ["native_event_type", S], ["native_artifact", S],
    ["native_locator", S], ["order_domain", S], ["order_value", I], ["event_time", S], ["t_rel_seconds", F], ["role", S], ["tool_name", S],
    ["tool_call_id", S], ["is_error", B], ["parent_event_key", S], ["attributes_json", S], ["content_status", S], ["content_ref_count", I],
    ["content_resolution", S], ["text", S], ["text_chars", I], ["text_sha256", S], ["content_json", S], ["content_json_chars", I]],
  event_relations: [["src_event_key", S], ["kind", S], ["dst_event_key", S], ["attempt_id", S]],
  assessments: [["assertion_id", S], ["attempt_id", S], ["run_id", S], ["card_id", S], ["family_id", S], ["ontology_version", S],
    ["producer_mode", S], ["rubric_id", S], ["rubric_version", S], ["evaluator_id", S], ["evaluator_version", S], ["evaluator_config_digest", S], ["verdict", S],
    ["value", S], ["direction", S], ["confidence", F], ["confidence_scale", S], ["probability", F], ["probabilities_json", S], ["thresholds_json", S],
    ["evidence_json", S], ["review", S], ["rationale", S], ["alternative_explanation", S],
    ["assertion_digest", S], ["dataset_digest", S], ["citation_count", I], ["claim_count", I]],
  assessment_cohorts: [["assertion_id", S], ["cohort_id", S], ["included", B], ["disputed", B], ["review_outcome", S]],
  citations: [["assertion_id", S], ["ordinal", I], ["attempt_id", S], ["event_id", S], ["event_key", S], ["occurrence_id", S],
    ["native_artifact", S], ["native_locator", S], ["resolved", B]],
  claims: [["assertion_id", S], ["claim_id", S], ["ordinal", I], ["text", S], ["workspace", S], ["citation_event_keys", S]],
  observations: [["observation_id", S], ["attempt_id", S], ["run_id", S], ["extractor_id", S], ["extractor_version", S], ["definition", S],
    ["value_status", S], ["value_json", S], ["value_num", F], ["unit", S], ["denominator_scope", S], ["denominator_value", F],
    ["denominator_unit", S], ["source_record_count", I], ["source_event_count", I]],
  observation_sources: [["observation_id", S], ["attempt_id", S], ["event_id", S], ["event_key", S]],
  occurrences: [["occurrence_id", S], ["attempt_id", S], ["type", S], ["rule_id", S], ["rule_version", S], ["heuristic", B],
    ["first_event_key", S], ["event_count", I], ["event_keys", S], ["attributes_json", S]],
  edges: [["src_type", S], ["src_id", S], ["rel", S], ["dst_type", S], ["dst_id", S]],
  units: [["unit_id", S], ["attempt_id", S], ["seq", I], ["unit_kind", S], ["subkind", S], ["role", S], ["episode_id", S], ["model_id", S],
    ["harness_id", S], ["task_id", S], ["trial_id", S], ["condition", S], ["terminal_state", S], ["tool_name", S], ["tool_kind", S],
    ["command", S], ["command_head", S], ["check_kind", S], ["check_kinds", L], ["writes", L], ["target", S], ["status", S], ["exit_code", I],
    ["duration_seconds", F], ["input_chars", I], ["output_chars", I], ["output_lines", I], ["lines_added", I], ["lines_removed", I],
    ["error_signature", S], ["tool_count", I], ["error_count", I], ["t_start", S], ["t_end", S], ["event_count", I], ["first_event_key", S],
    ["cited_assertions", L], ["cited_assessments", L], ["cited", B], ["observation_extractors", L], ["occurrences", L], ["embed", B],
    ["embed_text", S], ["embed_chars", I]],
  unit_events: [["unit_id", S], ["event_key", S], ["part", S]],
};

const NOISE_KEYS = new Set(["id", "entryId", "parentId", "sessionId", "threadId", "turnId", "itemId", "requestId", "toolCallId", "callId",
  "call_id", "timestamp", "ts", "createdAt", "updatedAt", "signature", "thinkingSignature", "encrypted_content", "encryptedContent",
  "digest", "sha256", "inputDigest", "eventSeq", "usage", "cost", "api", "provider"]);

/** Searchable text of resolved native content: string leaves (short ones labelled with their key), JSON strings parsed. */
export function flattenText(value: unknown, key?: string, out: string[] = []): string[] {
  if (Array.isArray(value)) for (const item of value) flattenText(item, key, out);
  else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) if (!NOISE_KEYS.has(k)) flattenText(v, k, out);
  } else if (typeof value === "string") {
    const s = value.trim();
    if (!s) return out;
    if (s[0] === "{" || s[0] === "[") {
      try { return flattenText(JSON.parse(s), key, out); } catch { /* not JSON */ }
    }
    out.push(key && s.length <= 120 && !s.includes("\n") ? `${key}: ${s}` : s);
  } else if ((typeof value === "number" || typeof value === "boolean") && key) out.push(`${key}: ${String(value)}`);
  return out;
}

const sha256 = (data: string | Buffer) => `sha256:${createHash("sha256").update(data).digest("hex")}` as const;
/** Tables and native records can exceed what one Buffer holds. */
function fileSha256(path: string): `sha256:${string}` {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const fd = openSync(path, "r");
  try { let count: number; while ((count = readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count)); }
  finally { closeSync(fd); }
  return `sha256:${hash.digest("hex")}`;
}
const known = <T>(field: { status: string; value?: T }) => (field.status === "known" ? field.value ?? null : null);
const str = (value: unknown) => (typeof value === "string" ? value : null);

function readRequest(path: string): AtlasBundleRequest {
  const request = JSON.parse(readFileSync(path, "utf8")) as AtlasBundleRequest;
  const errors = validateArtifact("atlas bundle request", request);
  if (errors.length) throw new Error(errors.map(({ field, message }) => `${field}: ${message}`).join("\n"));
  if (new Set(request.cohorts.map(({ id }) => id)).size !== request.cohorts.length) throw new Error("Atlas bundle cohort ids must be unique.");
  if (request.condition) {
    // The condition pattern is study configuration (trusted, at most 1000 characters by the request schema).
    const pattern = new RegExp(request.condition.pattern, "u"); // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
    if (!/\(\?<condition>/u.test(request.condition.pattern)) throw new Error(`Condition pattern ${String(pattern)} needs a named group "condition".`);
  }
  return request;
}


function eventRow(event: UniformEvent, index: number, resolve: ReturnType<typeof contentResolver>): Row {
  const key = `${event.attemptId}/${event.id}`;
  const attrs = event.attributes as Record<string, unknown>;
  const refs = event.content.status === "known" ? event.content.value : [];
  const resolved: unknown[] = [];
  let resolution = refs.length ? "resolved" : "no-content";
  for (const ref of refs) {
    const result = resolve(ref.nativeReference);
    if (result.status === "resolved") resolved.push(result.value);
    else resolution = result.status;
  }
  const text = resolved.length ? flattenText(resolved).join("\n") : "";
  const contentJson = resolved.length ? JSON.stringify(resolved) : null;
  const parent = event.relations.parent;
  const toolName = str(attrs.toolName) ?? (event.family === "tool" ? str(attrs.name) : null) ?? (event.actor.kind === "tool" ? event.actor.id ?? null : null);
  return {
    event_key: key, event_id: event.id, attempt_id: event.attemptId, run_id: event.runId, dataset_index: index, family: event.family,
    phase: event.phase, actor_kind: event.actor.kind, actor_id: event.actor.id ?? null, scope_kind: event.scope.kind, scope_id: event.scope.id ?? null,
    harness: event.source.harness, native_type: event.source.nativeType,
    native_event_type: str(attrs.eventType) ?? str(attrs.itemType) ?? str(attrs.method) ?? event.source.nativeType,
    native_artifact: event.source.nativeReference.artifactId, native_locator: event.source.nativeReference.recordLocator,
    order_domain: event.nativeOrder.status === "known" ? event.nativeOrder.domain : null,
    order_value: event.nativeOrder.status === "known" ? event.nativeOrder.value : null,
    event_time: known(event.nativeTime), t_rel_seconds: null, role: str(attrs.role), tool_name: toolName,
    tool_call_id: operationAlias(event, "atlas") ?? null,
    is_error: typeof attrs.isError === "boolean" ? attrs.isError : null,
    parent_event_key: parent.status === "known" && parent.value ? `${event.attemptId}/${parent.value}` : null,
    attributes_json: JSON.stringify(attrs), content_status: event.content.status, content_ref_count: refs.length, content_resolution: resolution,
    // Sizes only for content that resolved; unresolved content is unavailable, not an empty payload.
    text: text || null, text_chars: resolved.length ? text.length : null, text_sha256: text ? sha256(text) : null, content_json: contentJson,
    content_json_chars: contentJson === null || contentJson === undefined ? null : contentJson.length,
  };
}

/**
 * Rows of the large tables (events with their native content, relations, unit links, edges) go to disk as they are
 * produced; a study's native content can far exceed memory.
 */
const STREAMED = new Set(["events", "event_relations", "observation_sources", "unit_events", "edges", "units", "assessments", "assessment_cohorts", "citations", "claims",
  "observations", "occurrences", "attempt_cohorts"]);
class TableSink {
  readonly staging = mkdtempSync(join(tmpdir(), `ebo-atlas-tables-${process.pid}-`));
  private fds = new Map<string, number>();
  readonly counts = new Map<string, number>();
  readonly maxRowBytes = new Map<string, number>();
  push(name: string, row: Row) {
    let fd = this.fds.get(name);
    if (fd === undefined) { fd = openSync(join(this.staging, `${name}.ndjson`), "w"); this.fds.set(name, fd); }
    const text = JSON.stringify(Object.fromEntries(ATLAS_TABLES[name]!.map(([column]) => [column, row[column] ?? null])));
    this.maxRowBytes.set(name, Math.max(this.maxRowBytes.get(name) ?? 0, Buffer.byteLength(text)));
    writeSync(fd, `${text}\n`);
    this.counts.set(name, (this.counts.get(name) ?? 0) + 1);
  }
  close() { for (const fd of this.fds.values()) closeSync(fd); this.fds.clear(); }
  /** Close and remove the staging directory (it holds resolved native content); safe to call more than once. */
  dispose() { this.close(); rmSync(this.staging, { recursive: true, force: true }); }
}

async function writeTables(tables: Record<string, Row[]>, directory: string, sink: TableSink) {
  mkdirSync(directory, { recursive: true });
  const staging = sink.staging;
  sink.close();
  // A study's event table can exceed memory: one thread, a fixed budget, spill to the staging directory.
  const db = await DuckDBInstance.create(":memory:", { autoinstall_known_extensions: "false", autoload_known_extensions: "false",
    threads: "1", memory_limit: "4GB", preserve_insertion_order: "false", temp_directory: join(staging, "duckdb-spill") });
  const connection = await db.connect();
  const quote = (s: string) => `'${s.replace(/'/gu, "''")}'`;
  try {
    const out: AtlasBundleManifest["tables"] = {};
    for (const [name, columns] of Object.entries(ATLAS_TABLES)) {
      const ndjson = join(staging, `${name}.ndjson`);
      let count: number;
      // The reader's buffers scale with the object-size limit, so it follows the largest row written.
      let maxRowBytes = sink.maxRowBytes.get(name) ?? 0;
      if (STREAMED.has(name)) count = sink.counts.get(name) ?? 0;
      else {
        // One line at a time: a study's native content can exceed the largest single string V8 allows.
        const rows = tables[name] ?? [];
        const fd = openSync(ndjson, "w");
        try {
          for (const row of rows) {
            const text = JSON.stringify(Object.fromEntries(columns.map(([column]) => [column, row[column] ?? null])));
            maxRowBytes = Math.max(maxRowBytes, Buffer.byteLength(text));
            writeSync(fd, `${text}\n`);
          }
        } finally { closeSync(fd); }
        count = rows.length;
      }
      const path = join(directory, `${name}.parquet`);
      const spec = `{${columns.map(([column, type]) => `${column}: ${quote(type)}`).join(", ")}}`;
      const select = count
        ? `SELECT ${columns.map(([column]) => column).join(", ")} FROM read_json(${quote(ndjson)}, format = 'newline_delimited', columns = ${spec}, maximum_object_size = ${String(Math.max(1024 * 1024, maxRowBytes + 16384))})`
        : `SELECT ${columns.map(([column, type]) => `CAST(NULL AS ${type}) AS ${column}`).join(", ")} WHERE false`;
      await connection.run(`COPY (${select}) TO ${quote(path)} (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE_BYTES '16MB')`);
      out[name] = { path: `tables/${name}.parquet`, rows: count, sha256: fileSha256(path) };
    }
    return out;
  } finally {
    connection.closeSync();
    db.closeSync();
    rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Build into a temporary sibling and publish it by rename only after the manifest validates, so a failed build
 * (invalid source, DuckDB, embedding provider) never leaves a partial bundle at the destination.
 */
export async function buildAtlasBundle(requestPath: string, destination: string,
  options: { now?: () => Date; embed?: typeof embedTexts; embedding?: EmbeddingOptions; layout?: typeof layoutCloud; evidenceReuse?: RetainedEvidenceReuseStats; splitViewerDocuments?: boolean; attemptWorkers?: number; compactCloud?: boolean } = {}): Promise<AtlasBundleManifest> {
  const request = readRequest(requestPath);
  if (existsSync(destination) && readdirSync(destination).length) throw new Error(`Atlas bundle output ${destination} is not empty; choose a new directory.`);
  mkdirSync(dirname(resolve(destination)), { recursive: true });
  const outputRoot = mkdtempSync(join(dirname(resolve(destination)), `.${basename(destination)}.partial-`));
  const sink = new TableSink();
  try {
    const manifest = await withCorpusValidationReuse(() => withRetainedEvidenceReuse(() => writeAtlasBundle(request, requestPath, outputRoot, sink, options), options.evidenceReuse));
    if (existsSync(destination)) rmSync(destination, { recursive: true });
    renameSync(outputRoot, destination);
    return manifest;
  } catch (error) {
    rmSync(outputRoot, { recursive: true, force: true });
    throw error;
  } finally {
    sink.dispose();
  }
}

function leaderboardLabels(base: string, source: AtlasBundleRequest["leaderboard"]) {
  const labels = new Map<string, { taskId?: string; trialId?: string; outcome?: string }>();
  if (!source) return labels;
  const { manifest, corpusIndex, facts } = readLeaderboardCohort(resolve(base, source.store), source.cohortId);
  const digests = new Map(corpusIndex.filter((entry) => entry.manifestKind === "import").map((entry) => [`corpus/${entry.manifestPath}`, entry.manifestDigest]));
  const consensus = (values: readonly unknown[]) => {
    const value = values[0];
    return typeof value === "string" && value.length > 0 && values.every((other) => other === value) ? value : undefined;
  };
  for (const member of manifest.members) {
    const digest = digests.get(`${member.corpusPath}/manifest.json`);
    if (!digest || labels.has(digest)) throw new Error("Leaderboard Atlas source must bind each execution to one import manifest.");
    const ids = new Set(member.factIds);
    const boundFacts = facts.filter(({ id }) => typeof id === "string" && ids.has(id));
    const outcomes = [...new Set(member.sourceOutcomes.map(({ outcome }) => outcome))];
    labels.set(digest, {
      taskId: consensus(boundFacts.map(({ task }) => task)),
      trialId: consensus(boundFacts.map(({ trial }) => trial)),
      outcome: outcomes.length > 1 ? "mixed" : outcomes[0],
    });
  }
  return labels;
}

async function writeAtlasBundle(request: AtlasBundleRequest, requestPath: string, outputRoot: string, sink: TableSink,
  options: { now?: () => Date; embed?: typeof embedTexts; embedding?: EmbeddingOptions; layout?: typeof layoutCloud; splitViewerDocuments?: boolean; attemptWorkers?: number; compactCloud?: boolean }): Promise<AtlasBundleManifest> {
  const base = dirname(resolve(requestPath));
  // A missing embedding runtime fails here, before hours of attempt processing, not at the end.
  const embeddingConfig = selectEmbeddings(request.embeddings, base);
  if (embeddingConfig.provider === "embeddinggemma" && !embeddingConfig.python && !options.embed && !options.embedding?.command) {
    throw new Error("EmbeddingGemma 2 needs its Python runtime: set embeddings.python in the bundle request or EBO_EMBEDDINGS_PYTHON (install it from scripts/embeddings/requirements.txt), or choose the offline provider \"hashed-tfidf\" explicitly.");
  }
  if (!options.embed && !options.embedding?.command) await checkEmbeddingRuntime(embeddingConfig, { layout: embeddingConfig.layout !== "browser" && !options.layout, progress: options.embedding?.progress });
  const sourceLabels = leaderboardLabels(base, request.leaderboard);
  const condition = request.condition ? new RegExp(request.condition.pattern, "u") : undefined; // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  const tables: Record<string, Row[]> = Object.fromEntries(Object.keys(ATLAS_TABLES).filter((name) => !STREAMED.has(name)).map((name) => [name, []]));
  const stream = (name: string, row: Row) => sink.push(name, row);
  const cohorts: AtlasBundleManifest["cohorts"] = [];
  const attempts = new Map<string, { entry: CorpusIndexEntry; bundleRoot: string; cohorts: Set<string> }>();
  // Observation sets and assertions are re-read per attempt in the bundle pass; between passes only their
  // identities are kept, so memory does not grow with millions of card results.
  const observationSets = new Map<string, { path: string; digest: string }>();
  type SlimAssertion = { digest: string; review: string; attemptId: string; flags: Map<string, { included: boolean; disputed: boolean; review: string }>; cohorts: Set<string> };
  const assertions = new Map<string, SlimAssertion>();
  // An assertion file holds one document; an assertion set holds one per line.
  const assertionFiles = new Map<string, Map<string, "document" | "lines">>();
  mkdirSync(join(outputRoot, "reports"), { recursive: true });
  mkdirSync(join(outputRoot, "native"), { recursive: true });
  const reports = new Map<string, { title: string; generatedAt: string; groupBy: unknown; cells: CertifiedCell[] }>();

  // Assertion ids must name one assertion across the bundle. Checking them from the requests first fails in seconds
  // instead of after every cohort's validation.
  const declared = new Map<string, { digest: string; attemptId: string }>();
  const aggregationOf = (atlasPath: string) => resolve(dirname(atlasPath), (JSON.parse(readFileSync(atlasPath, "utf8")) as { aggregationRequest: string }).aggregationRequest);
  for (const cohort of request.cohorts) {
    const aggregationPath = aggregationOf(resolve(base, cohort.atlasRequest));
    const aggregation = JSON.parse(readFileSync(aggregationPath, "utf8")) as AggregationRequest;
    const aggregateBase = dirname(aggregationPath);
    for (const [kind, list] of [["document", aggregation.sources.assertions], ["lines", aggregation.sources.assertionSets ?? []]] as const) for (const { bundleRoot, path } of list) {
      const key = resolve(aggregateBase, bundleRoot), files = assertionFiles.get(key) ?? new Map<string, "document" | "lines">();
      files.set(resolve(aggregateBase, path), kind);
      assertionFiles.set(key, files);
    }
    for (const { document } of readAggregationAssertions(aggregateBase, aggregation.sources)) {
      const digest = digestMetadata(document).value, known = declared.get(document.id);
      if (known && known.digest !== digest) throw new Error(`Assertion id ${document.id} names two different assertions (attempts ${known.attemptId} and ${document.attemptId}); assertion ids must be unique in an Atlas bundle.`);
      declared.set(document.id, { digest, attemptId: document.attemptId });
    }
  }
  declared.clear();

  for (const cohort of request.cohorts) {
    const atlasPath = resolve(base, cohort.atlasRequest);
    const aggregateBase = dirname(aggregationOf(atlasPath));
    // The bundle reads cases for identities and digests only; it writes its own documents from the validated originals.
    const source: AtlasSource = await loadAtlas(atlasPath, { display: false });
    const idOf = new Map(source.input.assertions.map(({ document }) => [`sha256:${digestMetadata(document).value}`, { id: document.id, attemptId: document.attemptId }] as const));
    const view: AtlasView = await queryAtlas(source);
    // Members are the (run, attempt) identities the cohort's selection policy keeps (every selected attempt has at
    // least one case): superseded retries, their observations and their assessments stay out, as they stay out of
    // the certified report.
    const selected = new Set(view.cases.map(({ runId, attemptId }) => `${runId}\0${attemptId}`));
    for (const entry of source.input.corpusEntries.filter(({ manifestKind, runId, attemptId }) => (manifestKind === "run" || manifestKind === "import") && selected.has(`${runId}\0${attemptId}`))) {
      const bundleRoot = resolve(source.corpusRoot, dirname(entry.manifestPath));
      // Cohorts may carry their own corpus copies: one attempt, one manifest digest, whichever copy is read.
      const known = attempts.get(entry.attemptId!) ?? { entry, bundleRoot, cohorts: new Set<string>() };
      // Atlas tables key attempts by attempt id: the same id in two different runs fails the build, never merges them.
      if (known.entry.manifestDigest !== entry.manifestDigest) throw new Error(`Attempt id ${entry.attemptId!} appears in two different run bundles (runs ${known.entry.runId ?? "?"} and ${entry.runId ?? "?"}); attempt ids must be unique in an Atlas bundle.`);
      known.cohorts.add(cohort.id);
      attempts.set(entry.attemptId!, known);
    }
    const aggregation = source.aggregation;
    for (const [index, { document }] of source.input.observationSets.entries()) {
      if (!selected.has(`${document.runId}\0${document.attemptId}`)) continue;
      const digest = digestMetadata(document).value, previous = observationSets.get(document.attemptId);
      if (previous && previous.digest !== digest) throw new Error(`Attempt ${document.attemptId} has two different observation sets.`);
      observationSets.set(document.attemptId, { path: resolve(aggregateBase, aggregation.sources.observationSets[index]!.path), digest });
    }
    for (const c of view.cases.filter((x) => x.assertion && x.assertionDigest)) {
      const original = idOf.get(c.assertionDigest!)!;
      // Review state is per cohort (each cohort has its own calibration inputs); the scalar says so when they differ.
      const entry = assertions.get(original.id) ?? { digest: c.assertionDigest!, review: c.review, attemptId: original.attemptId, flags: new Map(), cohorts: new Set<string>() };
      if (entry.cohorts.size && entry.review !== c.review) entry.review = "varies by cohort";
      if (entry.digest !== c.assertionDigest) throw new Error(`Assertion id ${original.id} names two different assertions (attempts ${entry.attemptId} and ${original.attemptId}); assertion ids must be unique in an Atlas bundle.`);
      entry.cohorts.add(cohort.id);
      assertions.set(original.id, entry);
    }
    const members = behaviorMembers(view.report, source.input.assertions.map(({ document }) => document));
    for (const group of members) for (const behavior of group) for (const a of behavior) {
      stream("assessment_cohorts", { assertion_id: a.id, cohort_id: cohort.id, included: a.included, disputed: a.disputed, review_outcome: a.reviewOutcome });
      assertions.get(a.id)?.flags.set(cohort.id, { included: a.included === true, disputed: a.disputed === true, review: String(a.reviewOutcome ?? "") });
    }
    const report = { schemaVersion: "ebo.atlas-bundle-report/v1", cohort: cohort.id, title: view.title, mode: view.mode, generatedAt: view.generatedAt,
      sourceDigest: view.sourceDigest, cohortDigest: view.cohortDigest, sourceAttempts: view.sourceAttempts, matchingCases: view.matchingCases, report: view.report };
    writeJsonFile(join(outputRoot, "reports", `${cohort.id}.json`), report, 2);
    // Keep the certified cells, not the report: the report is in its file, and claims read it from there.
    reports.set(cohort.id, { title: view.title, generatedAt: view.generatedAt, groupBy: (view.report.policy as { groupBy?: unknown }).groupBy ?? null,
      cells: view.report.groups.flatMap((group, g) => (group.behaviors ?? []).map((b, i) => ({ group: group.dimensions, card: b.behavior.cardId, family: b.family, mode: b.producer.mode, producer: producerLabel(b.producer),
        counts: Object.fromEntries(b.verdicts.map((a) => [a.verdict, a.measurement.numerator.value])),
        denominator: Math.max(...b.verdicts.map((a) => a.measurement.denominator.value)),
        // Dimension cards: each value's count among the attempts judged present.
        ...(b.values === undefined ? {} : { values: Object.fromEntries(b.values.map((a) => [a.value, a.measurement.numerator.value])) }),
        assertions: members[g]![i]!.filter((a) => a.included).map((a) => a.id) }))) });
    cohorts.push({ id: cohort.id, title: view.title, sourceDigest: view.sourceDigest, cohortDigest: view.cohortDigest,
      attempts: source.input.corpusEntries.filter(({ manifestKind }) => manifestKind === "run" || manifestKind === "import").length, assertions: source.input.assertions.length, report: `reports/${cohort.id}.json` });
    tables.cohorts!.push({ cohort_id: cohort.id, title: view.title, atlas_request: relative(base, atlasPath), report_mode: view.mode,
      cohort_digest: view.cohortDigest, source_digest: view.sourceDigest, report_generated_at: view.generatedAt, source_attempts: view.sourceAttempts,
      matching_cases: view.matchingCases, group_by: JSON.stringify(source.aggregation.groupBy), operator_narrative: source.request.operatorNarrative ?? null });
  }

  // With a condition pattern every run bundle must match it; a naming mistake is an error, not a synthesized arm.
  const separateOrigins = [...attempts.values()].some(({ entry }) => entry.manifestKind === "import");
  const armOf = (name: string, entry: CorpusIndexEntry) => {
    // An imported arm names the harness version too: two releases of one harness share an agent name.
    const version = entry.manifestKind === "import" && entry.harnessVersion && entry.harnessVersion !== "unavailable" ? ` ${entry.harnessVersion}` : "";
    const arm = condition ? condition.exec(name)?.groups?.condition : `${entry.modelId ?? "unavailable"} · ${entry.harnessId ?? "unavailable"}${version}`;
    if (!arm) throw new Error(`Run bundle ${name} does not match the condition pattern ${request.condition!.pattern}.`);
    return separateOrigins ? `${entry.manifestKind === "import" ? "Imported" : "Owned"} · ${arm}` : arm;
  };
  // A large bundle keeps the viewer's per-attempt documents (assessment details, audits, lane series) in one file per
  // attempt, with a compact index the viewer loads up front; a small one keeps them inline.
  const split = options.splitViewerDocuments ?? attempts.size > SPLIT_ATTEMPTS;
  if (split) for (const directory of ["assessments", "audit", "lanes"]) mkdirSync(join(outputRoot, directory), { recursive: true });
  const index = split ? new AssessmentIndex() : undefined;
  const cloud = new CloudWriter(join(sink.staging, "cloud.ndjson"));
  const audits: Record<string, unknown> = {};
  const lanes: { attempts: LaneMeta[]; usage: Record<string, Array<[number, number]>>; context: Record<string, Array<[number, number]>>; split?: string } = { attempts: [], usage: {}, context: {} };
  const attemptMeta: Array<Record<string, unknown>> = [];
  const assessmentDocs: unknown[] = [];
  const judgedCardIds = new Set<string>();
  const sortedAttempts = [...attempts].sort(([a], [b]) => a.localeCompare(b));
  const slimOf = new Map<string, Array<[string, SlimAssertion]>>();
  for (const [id, slim] of assertions) { const list = slimOf.get(slim.attemptId); if (list) list.push([id, slim]); else slimOf.set(slim.attemptId, [[id, slim]]); }
  const jobs = sortedAttempts.map(([attemptId, { entry: corpusEntry, bundleRoot, cohorts: memberOf }]): AttemptJob => {
    const source = corpusEntry.manifestKind === "import" ? sourceLabels.get(corpusEntry.manifestDigest) : undefined;
    const entry = source ? { ...corpusEntry, taskId: source.taskId, trialId: source.trialId } : corpusEntry;
    // The trial's third-party verdict: from the leaderboard cohort store, or as the import declared it.
    const outcome = source?.outcome !== undefined ? { outcome: source.outcome, source: "Harness Leaderboard" }
      : entry.sourceOutcome !== undefined ? { outcome: entry.sourceOutcome, source: entry.sourceOutcomeSource ?? "third party",
        ...(entry.sourceOutcomeRelease ? { release: entry.sourceOutcomeRelease } : {}), ...(entry.sourceOutcomeRecord ? { record: entry.sourceOutcomeRecord } : {}) } : undefined;
    const files = [...assertionFiles.get(resolve(bundleRoot)) ?? []];
    return { attemptId, entry, ...(outcome ? { outcome } : {}), bundleRoot, memberOf: [...memberOf].sort(), arm: armOf(basename(bundleRoot), entry), base,
      assertionFiles: files, slim: Object.fromEntries((slimOf.get(attemptId) ?? []).map(([id, slim]) => [id, { digest: slim.digest, review: slim.review, flags: [...slim.flags] }])),
      ...(observationSets.has(attemptId) ? { observationSetPath: observationSets.get(attemptId)!.path } : {}) };
  });
  // Attempts are processed in worker processes when there are many and written here in attempt order; each result's
  // cloud row ids start at 0 and are shifted by the rows already written.
  for await (const result of processAttempts(jobs, options.attemptWorkers)) {
    const offset = cloud.rows, shifted = shiftAttemptRows(result, offset);
    for (const [name, row] of shifted.rows) stream(name, row);
    tables.attempts!.push(shifted.attemptTableRow);
    for (const row of shifted.cloudRows) cloud.push(row);
    if (split) writeJsonFile(join(outputRoot, "audit", `${fileName(shifted.attemptId)}.json`), shifted.audit);
    else audits[shifted.attemptId] = shifted.audit;
    writeJsonFile(join(outputRoot, "native", `${fileName(shifted.attemptId)}.json`), shifted.native);
    lanes.attempts.push(shifted.lane.lane);
    if (split) { if (shifted.lane.usage || shifted.lane.context) writeJsonFile(join(outputRoot, "lanes", `${fileName(shifted.attemptId)}.json`), { usage: shifted.lane.usage ?? null, context: shifted.lane.context ?? null }); }
    else { if (shifted.lane.usage) lanes.usage[shifted.attemptId] = shifted.lane.usage; if (shifted.lane.context) lanes.context[shifted.attemptId] = shifted.lane.context; }
    const attemptOrdinal = attemptMeta.length;
    attemptMeta.push(shifted.meta);
    for (const doc of shifted.docs) index?.push(doc, attemptOrdinal);
    for (const card of shifted.cards) judgedCardIds.add(card);
    if (split) { if (shifted.docs.length) writeJsonFile(join(outputRoot, "assessments", `${fileName(shifted.attemptId)}.json`), shifted.docs); }
    else assessmentDocs.push(...shifted.docs);
  }

  // The cloud: units.arrow (Arrow IPC, so DuckDB-WASM needs no extensions) and the embeddings in row order. The cloud
  // rows are staged with the tables, so the cloud is written before the tables release their staging directory.
  const cloudRows = cloud.finish();
  const embeddingRun = await (options.embed ?? embedTexts)(cloud.texts, embeddingConfig, join(outputRoot, "embeddings.f32"), options.embedding);
  cloud.texts.length = 0;
  // A large cloud is laid out here, where a GPU can do it; the viewer lays out a small one from the vectors.
  const buildLayout = embeddingConfig.layout === "build" || (embeddingConfig.layout === "auto" && cloudRows.rows > BUILD_LAYOUT_UNITS && (embeddingConfig.python !== undefined || options.layout !== undefined));
  const layout = buildLayout ? await (options.layout ?? layoutCloud)(join(outputRoot, "embeddings.f32"), embeddingConfig.dimensions, cloud.families, embeddingConfig, options.embedding) : undefined;
  // A cloud of millions of units is clustered here too and written compactly (repeated strings as dictionaries, a short
  // text label, no per-unit ids or neighbors), so the browser only loads the table.
  const compact = layout !== undefined && (options.compactCloud ?? cloudRows.rows > COMPACT_UNITS) ? compactCloud(cloudRows, layout.xy, cloud.families) : undefined;
  if (compact) writeJsonFile(join(outputRoot, "labels.json"), compact.labels);
  cloud.families.length = 0;
  await writeCloudArrow(cloudRows, join(outputRoot, "units.arrow"), layout, compact);
  const tableIndex = await writeTables(tables, join(outputRoot, "tables"), sink);

  writeJsonFile(join(outputRoot, "lanes.json"), split ? { ...lanes, split: "lanes/" } : lanes);
  writeJsonFile(join(outputRoot, "audit.json"), split ? { study: request.id, attempts: {}, split: "audit/" } : { study: request.id, attempts: audits });
  const armOfAttempt = new Map(tables.attempts!.map((a) => [String(a.attempt_id), String(a.condition)]));
  const certified = Object.fromEntries([...reports].map(([id, report]) => [id, { source: `reports/${id}.json`, generated_at: report.generatedAt, group_by: report.groupBy,
    cells: report.cells.map(({ assertions: ids, ...cell }) => ({ ...cell,
      // The judgments behind a cell; a large bundle leaves the list out and the viewer derives it from the index.
      ...(split ? {} : { assertions: ids }),
      // The study arms the cell's assessments belong to: the viewer compares a cell with one arm only when it covers that arm alone.
      conditions: [...new Set(ids.map((assertionId) => armOfAttempt.get(assertions.get(assertionId)?.attemptId ?? "") ?? "unavailable"))].sort() })) }]));
  const ontology = loadDefaultBehaviorOntology();
  const judgedCards = ontology.cards.filter(({ id }) => judgedCardIds.has(id));
  const assessmentsDocument = { study: request.id, generated_by: `${ATLAS_BUNDLE_BUILDER.id} ${ATLAS_BUNDLE_BUILDER.version}`,
    outcomes: [...BEHAVIOR_VERDICTS], modes: [...BEHAVIOR_PRODUCER_MODES], directions: [...BEHAVIOR_DIRECTIONS], ontology: ontology.version,
    // The judged cards and their families in ontology order: the viewer's matrix rows.
    cards: judgedCards.map((card) => ({ id: card.id, family: card.family, title: card.title,
      directions: [...new Set(card.kind === "dimension" ? (card.values ?? []).map(({ direction }) => direction) : [card.direction])].filter((d): d is NonNullable<typeof d> => d !== undefined).sort() })),
    families: ontology.families.filter(({ id }) => judgedCards.some(({ family }) => family === id)).map(({ id, name }) => ({ id, name })),
    cohorts: [...reports].map(([id, report]) => ({ id, title: report.title, report: `reports/${id}.json`, certified: true })),
    attempts: attemptMeta, assessments: split ? [] : assessmentDocs, certified,
    ...(index ? { index: await index.write(join(outputRoot, "assessments.arrow"), "assessments.arrow"), split: "assessments/" } : {}),
    notes: ["An outcome is the verdict on one card: present, absent or unknown. Unknown is the abstention. A present dimension card also names one value.",
      "Every result names its producer mode. An LLM judge read a selection of events and cites them; a decision model read every step and returns probabilities only. The two are never pooled.",
      "A present result has a direction fixed by the ontology: favourable, unfavourable or neutral. Neutral results are counted and never scored.",
      "Certified tallies are the cohort aggregation reports in this bundle; counts computed in the viewer are exploratory."] };
  writeJsonFile(join(outputRoot, "assessments.json"), assessmentsDocument);

  // View receipts over the viewer's host tables; claims over the bundle tables (two connections, as each consumer sees them).
  const quote = (p: string) => `'${p.replace(/'/gu, "''")}'`;
  const tablePath = (name: string) => quote(join(outputRoot, "tables", `${name}.parquet`));
  const extensionsOff = { autoinstall_known_extensions: "false", autoload_known_extensions: "false" };
  let viewIds = new Set<string>();
  if (request.views) {
    const db = await DuckDBInstance.create(":memory:", extensionsOff);
    const c = await db.connect();
    try {
      await c.run(`CREATE TABLE units AS SELECT * FROM ${tablePath("units")} WHERE embed`);
      // The viewer's assessments table, from the bundle tables: an attempt's arm, task and trial, and whether the result
      // is included in the cohort named primary (an attempt in primary with no cohort row for the result counts as included).
      await c.run(`CREATE TABLE assessments AS SELECT a.assertion_id AS id, a.attempt_id, t.condition, t.task_id, t.trial_id, a.producer_mode AS mode,
        a.card_id AS card, a.family_id AS family, a.verdict AS outcome, a.value, a.direction, a.confidence, a.probability, a.citation_count AS citations,
        coalesce(ac.included, pa.attempt_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${tablePath("assessment_cohorts")} x WHERE x.assertion_id = a.assertion_id)) AS in_primary
        FROM ${tablePath("assessments")} a JOIN ${tablePath("attempts")} t USING (attempt_id)
        LEFT JOIN (SELECT * FROM ${tablePath("assessment_cohorts")} WHERE cohort_id = 'primary') ac ON ac.assertion_id = a.assertion_id
        LEFT JOIN (SELECT * FROM ${tablePath("attempt_cohorts")} WHERE cohort_id = 'primary') pa ON pa.attempt_id = a.attempt_id ORDER BY a.attempt_id, a.assertion_id`);
      const views = await buildViews(resolve(base, request.views), c, request.id);
      viewIds = new Set(views.views.map(({ id }) => id));
      writeFileSync(join(outputRoot, "views.json"), JSON.stringify(views));
    } finally { c.closeSync(); db.closeSync(); }
  }
  if (request.claims) {
    const db = await DuckDBInstance.create(":memory:", extensionsOff);
    const c = await db.connect();
    const files = new Map<string, Buffer | null>();
    const importedPaths = new Set([...attempts.values()].filter(({ entry }) => entry.manifestKind === "import")
      .map(({ bundleRoot }) => resolve(bundleRoot, "trajectory.json")));
    try {
      for (const name of ["assessments", "attempts", "assessment_cohorts", "attempt_cohorts", "citations"]) await c.run(`CREATE VIEW ${name} AS SELECT * FROM ${tablePath(name)}`);
      await c.run(`CREATE VIEW units AS SELECT * FROM ${tablePath("units")} WHERE embed`);
      const attemptsById = Object.fromEntries(tables.attempts!.map((a) => [String(a.attempt_id), { model_id: a.model_id as string | null, harness_id: a.harness_id as string | null }]));
      // Claims read the documents the viewer shows: from the split files of a large bundle, and the reports from theirs.
      const perAttempt = (directory: string) => readdirSync(join(outputRoot, directory)).map((f) => JSON.parse(readFileSync(join(outputRoot, directory, f), "utf8")) as unknown);
      const claimDocs = split ? perAttempt("assessments").flat() : assessmentDocs;
      const claimAudits = split ? Object.fromEntries(perAttempt("audit").map((audit) => [String((audit as { attempt_id: string }).attempt_id), audit])) : audits;
      const claims = await validateClaims(JSON.parse(readFileSync(resolve(base, request.claims), "utf8")) as ClaimsSource, {
        connection: c, certified, reports: Object.fromEntries([...reports.keys()].map((id) => [id, { report: (JSON.parse(readFileSync(join(outputRoot, "reports", `${id}.json`), "utf8")) as { report: AtlasView["report"] }).report }])),
        assessments: claimDocs as never, audits: claimAudits as never, attempts: attemptsById, viewIds,
        recordSha256: (path, locator) => {
          if (!files.has(path)) { try { files.set(path, readFileSync(resolve(base, path))); } catch { files.set(path, null); } }
          return nativeRecordDigest(files.get(path)!, locator, importedPaths.has(resolve(base, path)) ? "canonical-json-pointers/v1" : undefined)?.sha256;
        },
      });
      writeFileSync(join(outputRoot, "claims.json"), JSON.stringify(claims));
    } finally { c.closeSync(); db.closeSync(); }
  }
  const files = [...readdirSync(join(outputRoot, "reports")).map((f) => ({ path: `reports/${f}`, role: "cohort-report" })),
    ...Object.values(tableIndex).map(({ path }) => ({ path, role: "table" })),
    ...readdirSync(join(outputRoot, "native")).map((f) => ({ path: `native/${f}`, role: "native-records" })),
    ...(split ? [["assessments", "assessment-details"], ["audit", "audits"], ["lanes", "swimlane-series"]].flatMap(([directory, role]) =>
      readdirSync(join(outputRoot, directory!)).map((f) => ({ path: `${directory!}/${f}`, role: role! }))) : []),
    ...[["units.arrow", "cloud-units"], ["labels.json", "cloud-labels"], ["embeddings.f32", "cloud-embeddings"], ["lanes.json", "swimlanes"], ["audit.json", "audits"], ["assessments.json", "assessments"],
      ["assessments.arrow", "assessment-index"], ["claims.json", "claims"], ["views.json", "view-specs"]].filter(([path]) => existsSync(join(outputRoot, path!))).map(([path, role]) => ({ path: path!, role: role! }))]
    .map(({ path, role }) => ({ path, role, bytes: statSync(join(outputRoot, path)).size, sha256: fileSha256(join(outputRoot, path)) }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const manifest: AtlasBundleManifest = {
    schemaVersion: "ebo.atlas-bundle/v2", id: request.id, title: request.title, builder: ATLAS_BUNDLE_BUILDER, tablesVersion: ATLAS_TABLES_VERSION, unitsVersion: ATLAS_UNITS_VERSION,
    createdAt: (options.now ?? (() => new Date()))().toISOString(), request: { digest: `sha256:${digestMetadata(request).value}` },
    cloud: { units: cloudRows.rows, embeddings: { file: "embeddings.f32", provider: embeddingConfig.provider, model: embeddingConfig.model,
      ...(embeddingConfig.revision ? { revision: embeddingConfig.revision } : {}), dimensions: embeddingConfig.dimensions, run: embeddingRun },
      layout: layout ? { where: "build", run: layout.run, ...(compact ? { compact: true } : {}) } : { where: "browser" } },
    cohorts, tables: tableIndex, files,
  };
  const errors = validateArtifact("atlas bundle", manifest);
  if (errors.length) throw new Error(errors.map(({ field, message }) => `${field}: ${message}`).join("\n"));
  writeFileSync(join(outputRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** A manifest path must stay inside its root: relative, forward slashes, no empty, `.` or `..` segments. */
export function assertContainedPath(path: string): void {
  if (!path || path.startsWith("/") || path.includes("\\") || /^[A-Za-z]:/u.test(path) || path.split("/").some((s) => s === "" || s === "." || s === ".."))
    throw new Error(`Manifest path ${JSON.stringify(path)} is not a contained relative path.`);
}

/** One attempt's work for the bundle pass: everything a worker needs, as plain data. */
export type AttemptJob = {
  attemptId: string; entry: CorpusIndexEntry; outcome?: { outcome: string; source: string; release?: string; record?: string }; bundleRoot: string;
  memberOf: string[]; arm: string; base: string; assertionFiles: Array<[string, "document" | "lines"]>;
  slim: Record<string, { digest: string; review: string; flags: Array<[string, { included: boolean; disputed: boolean; review: string }]> }>; observationSetPath?: string;
};
/** One attempt's bundle rows and viewer documents, with cloud row ids counted from 0. */
export type AttemptResult = {
  attemptId: string; rows: Array<[string, Row]>; attemptTableRow: Row; cloudRows: Array<Record<string, unknown> & { row_id: number }>;
  native: { attempt_id: string; units: Record<string, unknown> }; audit: Record<string, unknown>;
  lane: { lane: LaneMeta; usage?: Array<[number, number]>; context?: Array<[number, number]> };
  meta: Record<string, unknown>; docs: Array<ReturnType<typeof assessmentDoc>>; cards: string[];
};

/**
 * Builds one attempt's rows and documents from its retained evidence, validated assertions and observation set. It
 * reads only files and writes nothing, so attempts can be processed in parallel and written in order.
 */
export async function processAttempt(job: AttemptJob): Promise<AttemptResult> {
  const { attemptId, entry, outcome, bundleRoot, memberOf, arm, base } = job;
  const rows: Array<[string, Row]> = [];
  const stream = (name: string, row: Row) => { rows.push([name, row]); };
  const edge = (src_type: string, src_id: unknown, rel: unknown, dst_type: string, dst_id: unknown) => stream("edges", { src_type, src_id: String(src_id), rel: String(rel), dst_type, dst_id: String(dst_id) });
  const eventKeys = new Set<string>(), cards = new Set<string>();
  const cloudRows: Array<AtlasUnit & Row & { row_id: number; t0_ms: number | null; t1_ms: number | null; timed: boolean }> = [];
  // This attempt's validated assertions, read again from their files and matched by id and digest.
  const own: Array<{ assertion: BehaviorAssertion; slim: AttemptJob["slim"][string]; id: string }> = [];
  for (const [path, kind] of job.assertionFiles) {
    const text = readFileSync(path, "utf8");
    for (const line of kind === "document" ? [text] : text.split("\n")) {
      if (!line.trim()) continue;
      const assertion = JSON.parse(line) as BehaviorAssertion, slim = job.slim[assertion.id];
      if (slim && assertion.attemptId === attemptId && !own.some(({ id }) => id === assertion.id) && `sha256:${digestMetadata(assertion).value}` === slim.digest) own.push({ assertion, slim, id: assertion.id });
    }
  }
  own.sort((a, b) => a.id.localeCompare(b.id));
  const observationSet = job.observationSetPath ? JSON.parse(readFileSync(job.observationSetPath, "utf8")) as StructuralObservationSet : undefined;
  // Units carry which judgments cite them and which structural observations draw on them.
  const citedBy = new Map<string, Array<{ id: string; label: string }>>();
  for (const { assertion } of own) {
    const label = `${assertion.behavior.cardId}:${assertion.judgment.verdict}`;
    for (const citation of isDecisionModelAssertion(assertion) ? [] : assertion.judgment.citations) {
      const key = `${assertion.attemptId}/${citation.eventId}`;
      citedBy.set(key, [...citedBy.get(key) ?? [], { id: assertion.id, label }]);
    }
  }
  const extractorsOf = new Map<string, Set<string>>();
  for (const observation of observationSet?.observations ?? []) for (const eventId of observation.sourceEventIds) {
    const key = `${attemptId}/${eventId}`;
    extractorsOf.set(key, (extractorsOf.get(key) ?? new Set()).add(observation.extractor.id));
  }
  const evidence = await createRetainedBehaviorEvidence(bundleRoot);
  const resolveContent = contentResolver(evidence);
  const derived = deriveUnits({ attemptId, evidenceOrigin: evidence.capture.qualification === "imported" ? "imported" : "owned", events: evidence.dataset.events, occurrences: observationSet?.occurrences ?? [],
    resolveContent: (reference) => { const r = resolveContent(reference); return r.status === "resolved" ? r.value : undefined; } });
  const times = evidence.dataset.events.flatMap((e) => (e.nativeTime.status === "known" && Number.isFinite(Date.parse(e.nativeTime.value)) ? [e.nativeTime.value] : []))
    .sort((a, b) => Date.parse(a) - Date.parse(b));
  const first = times[0], last = times.at(-1);
  const attemptTableRow = { attempt_id: attemptId, run_id: entry.runId ?? null, bundle_id: entry.bundleId ?? null, model_id: entry.modelId ?? null, model_route: entry.modelRoute ?? null,
    model_provider: entry.modelProvider ?? null, harness_id: entry.harnessId ?? null, harness_version: entry.harnessVersion ?? null, task_id: entry.taskId ?? null,
    fixture_id: entry.fixtureId ?? null, trial_id: entry.trialId ?? null, condition: arm,
    assessment_mode: entry.assessmentMode ?? null, capture_qualification: entry.captureQualification ?? null, terminal_state: entry.terminalState ?? null,
    failure_class: entry.failureClass ?? null, stop_reason: entry.stopReason ?? null, adapter_id: evidence.dataset.adapter.id, adapter_version: evidence.dataset.adapter.version,
    dataset_digest: observationSet?.normalization.datasetDigest ?? null, manifest_digest: entry.manifestDigest ?? null,
    bundle_root: relative(base, bundleRoot), event_count: evidence.dataset.events.length, native_record_count: evidence.coverage.records.total,
    unmapped_record_count: evidence.coverage.records.unmapped, first_event_time: first ?? null, last_event_time: last ?? null,
    native_span_seconds: first && last ? (Date.parse(last) - Date.parse(first)) / 1000 : null,
    source_outcome: outcome?.outcome ?? null, source_outcome_source: outcome?.source ?? null, source_outcome_release: outcome?.release ?? null, source_outcome_record: outcome?.record ?? null };
  for (const cohortId of memberOf) { stream("attempt_cohorts", { attempt_id: attemptId, cohort_id: cohortId }); edge("attempt", attemptId, "member-of", "cohort", cohortId); }

  const linksOf = new Map<string, string[]>();
  for (const link of derived.links) linksOf.set(link.unit_id, [...linksOf.get(link.unit_id) ?? [], link.event_key]);
  const membersOf = new Map<string, string[]>();
  for (const u of derived.units) if (u.episode_id) {
    const list = membersOf.get(u.episode_id) ?? [];
    if (!list.length) membersOf.set(u.episode_id, list);
    list.push(u.unit_id);
  }
  const ownUnits: Array<AtlasUnit & Row> = [];
  for (const unit of derived.units) {
    const keys = unit.unit_kind === "episode" ? (membersOf.get(unit.unit_id) ?? []).flatMap((id) => linksOf.get(id) ?? []) : linksOf.get(unit.unit_id) ?? [];
    const cites = [...new Map(keys.flatMap((k) => citedBy.get(k) ?? []).map((c) => [c.id, c])).values()].sort((a, b) => a.id.localeCompare(b.id));
    const row = { ...unit, model_id: entry.modelId ?? null, harness_id: entry.harnessId ?? null, task_id: entry.taskId ?? null, trial_id: entry.trialId ?? null,
      condition: arm, terminal_state: entry.terminalState ?? null, cited_assertions: cites.map(({ id }) => id), cited_assessments: cites.map(({ label }) => label),
      cited: cites.length > 0, observation_extractors: [...new Set(keys.flatMap((k) => [...extractorsOf.get(k) ?? []]))].sort() } as unknown as AtlasUnit & Row;
    stream("units", row);
    ownUnits.push(row);
  }
  for (const link of derived.links) stream("unit_events", link);
  // Event rows carry the resolved native content; each is written as soon as it is built, never held.
  for (const [index, event] of evidence.dataset.events.entries()) {
    const row = eventRow(event, index, resolveContent);
    if (eventKeys.has(String(row.event_key))) throw new Error(`Duplicate event key ${String(row.event_key)}.`);
    eventKeys.add(String(row.event_key));
    if (first && typeof row.event_time === "string") row.t_rel_seconds = (Date.parse(row.event_time) - Date.parse(first)) / 1000;
    stream("events", row);
    stream("edges", { src_type: "event", src_id: row.event_key, rel: "part-of", dst_type: "attempt", dst_id: attemptId });
    if (row.parent_event_key) stream("edges", { src_type: "event", src_id: row.event_key, rel: "child-of", dst_type: "event", dst_id: row.parent_event_key });
  }
  for (const event of evidence.dataset.events) for (const relation of event.relations.known) {
    stream("event_relations", { src_event_key: `${attemptId}/${event.id}`, kind: relation.kind, dst_event_key: `${attemptId}/${relation.eventId}`, attempt_id: attemptId });
    stream("edges", { src_type: "event", src_id: `${attemptId}/${event.id}`, rel: relation.kind, dst_type: "event", dst_id: `${attemptId}/${relation.eventId}` });
  }

  // Viewer documents for this attempt: cloud rows, swimlane, audit, native records and assessments.
  const short = shortAttemptId(attemptId);
  let carriedTime: number | null = null;
  const rowsOfAttempt: Array<AtlasUnit & Row & { row_id: number }> = [];
  for (const unit of ownUnits.filter((u) => u.embed).sort((a, b) => Number(a.seq) - Number(b.seq))) {
    const t0 = unit.t_start && Number.isFinite(Date.parse(unit.t_start)) ? Date.parse(unit.t_start) : null;
    const t1 = unit.t_end && Number.isFinite(Date.parse(unit.t_end)) ? Date.parse(unit.t_end) : null;
    const row = { ...unit, row_id: cloudRows.length, t0_ms: t0 ?? carriedTime, t1_ms: t0 === null ? carriedTime : t1 ?? t0, timed: t0 !== null };
    if (t0 !== null) carriedTime = unit.unit_kind === "episode" ? t0 : t1 ?? t0;
    cloudRows.push(row);
    rowsOfAttempt.push(row);
  }
  const native = new NativeLines(bundleRoot, relative(base, bundleRoot));
  const contentOf = (event: UniformEvent) => (event.content.status === "known"
    ? event.content.value.map(({ nativeReference }) => resolveContent(nativeReference)).flatMap((r) => (r.status === "resolved" ? [r.value] : [])) : []);
  const evidenceDocs = attemptEvidence({ attemptId, evidenceOrigin: evidence.capture.qualification === "imported" ? "imported" : "owned", short, condition: arm, trialId: entry.trialId ?? null, cohorts: [...memberOf], units: rowsOfAttempt,
    links: derived.links, events: evidence.dataset.events, occurrences: observationSet?.occurrences ?? [], native, resolveContent: contentOf });
  const attemptRow = { attempt_id: attemptId, task_id: entry.taskId ?? null, condition: arm, trial_id: entry.trialId ?? null, harness_id: entry.harnessId ?? null,
    harness_version: entry.harnessVersion ?? null,
    model_id: entry.modelId ?? null, terminal_state: entry.terminalState ?? null, failure_class: entry.failureClass ?? null, capture_qualification: entry.captureQualification ?? null,
    ...(outcome === undefined ? {} : { source_outcome: outcome.outcome, source_outcome_source: outcome.source,
      ...(outcome.release ? { source_outcome_release: outcome.release } : {}), ...(outcome.record ? { source_outcome_record: outcome.record } : {}) }) };
  const lane = laneData(attemptRow, rowsOfAttempt, evidence.dataset.events);
  lane.lane.cited_units = rowsOfAttempt.filter((u) => u.cited && u.unit_kind !== "episode").length;
  const eventTypes: Record<string, number> = {};
  for (const event of evidence.dataset.events) { const k = `${event.family} · ${String(event.attributes.eventType ?? event.attributes.itemType ?? event.attributes.method ?? event.source.nativeType)}`; eventTypes[k] = (eventTypes[k] ?? 0) + 1; }
  const meta = { ...attemptRow, short, cohorts: [...memberOf], bundle: relative(base, bundleRoot), native_span_seconds: attemptTableRow.native_span_seconds,
    native_record_count: evidence.coverage.records.total, unmapped_record_count: evidence.coverage.records.unmapped, event_count: evidence.dataset.events.length,
    event_types: eventTypes, units: ownUnits.filter((u) => u.unit_kind !== "episode").length, tool_calls: ownUnits.filter((u) => u.unit_kind === "tool").length };
  const docsOfAttempt: Array<ReturnType<typeof assessmentDoc>> = [];
  for (const { assertion, slim } of own) {
    const flags = Object.fromEntries(slim.flags);
    const doc = assessmentDoc(assertion, { short, condition: arm, taskId: entry.taskId ?? null, trialId: entry.trialId ?? null, review: slim.review,
      cohorts: Object.keys(flags).length ? flags : Object.fromEntries([...memberOf].map((c) => [c, { included: true }])) }, evidenceDocs.linkCitation, native);
    docsOfAttempt.push(doc);
    cards.add(assertion.behavior.cardId);
    writeAssessmentRows(assertion, slim, eventKeys, stream, edge);
  }
  for (const observation of observationSet?.observations ?? []) {
    const value = observation.value as { status?: string; value?: unknown; unit?: string };
    const { denominator } = observation;
    const sources = observation.sourceEventIds;
    stream("observations", { observation_id: observation.id, attempt_id: attemptId, run_id: observationSet!.runId, extractor_id: observation.extractor.id,
      extractor_version: observation.extractor.version, definition: observation.definition, value_status: value.status ?? null,
      value_json: JSON.stringify(value.value ?? null), value_num: typeof value.value === "number" ? value.value : null, unit: value.unit ?? null,
      denominator_scope: denominator.scope, denominator_value: denominator.value, denominator_unit: denominator.unit,
      source_record_count: observation.sourceRecordCount, source_event_count: sources.length });
    edge("observation", observation.id, "about", "attempt", attemptId);
    for (const eventId of sources) {
      stream("observation_sources", { observation_id: observation.id, attempt_id: attemptId, event_id: eventId, event_key: `${attemptId}/${eventId}` });
      stream("edges", { src_type: "observation", src_id: observation.id, rel: "derived-from", dst_type: "event", dst_id: `${attemptId}/${eventId}` });
    }
  }
  for (const occurrence of observationSet?.occurrences ?? []) {
    const keys = occurrence.eventIds.map((id) => `${attemptId}/${id}`);
    stream("occurrences", { occurrence_id: occurrence.id, attempt_id: attemptId, type: occurrence.type, rule_id: occurrence.rule.id, rule_version: occurrence.rule.version,
      heuristic: occurrence.rule.heuristic, first_event_key: keys[0]!, event_count: keys.length, event_keys: JSON.stringify(keys), attributes_json: JSON.stringify(occurrence.attributes) });
    edge("occurrence", occurrence.id, "about", "attempt", attemptId);
    for (const key of keys) edge("occurrence", occurrence.id, "derived-from", "event", key);
  }
  return { attemptId, rows, attemptTableRow, cloudRows, native: evidenceDocs.native as AttemptResult["native"], audit: evidenceDocs.audit as unknown as Record<string, unknown>,
    lane: { lane: lane.lane, ...(lane.usage ? { usage: lane.usage } : {}), ...(lane.context ? { context: lane.context } : {}) }, meta, docs: docsOfAttempt, cards: [...cards] };
}

/** A result's cloud row ids moved up by `offset`, wherever they appear: cloud rows, native records, audit runs and chains, citations. */
export function shiftAttemptRows(result: AttemptResult, offset: number): AttemptResult {
  if (offset === 0) return result;
  type Run = { row_id: number } | null | undefined;
  const run = <T extends Run>(r: T): T => (r ? { ...r, row_id: r.row_id + offset } : r);
  const audit = result.audit as { checks: Run[]; changes: Run[]; last: Record<string, null | { last: Run; last_ok: Run; first_change_after: Run }>; final: Run;
    failure_chains: Array<{ failures: number[]; next_same_tool: number | null }> };
  return { ...result,
    cloudRows: result.cloudRows.map((row) => ({ ...row, row_id: row.row_id + offset })),
    native: { ...result.native, units: Object.fromEntries(Object.entries(result.native.units).map(([row, unit]) => [String(Number(row) + offset), unit])) },
    audit: { ...result.audit, checks: audit.checks.map(run), changes: audit.changes.map(run), final: run(audit.final),
      last: Object.fromEntries(Object.entries(audit.last).map(([kind, l]) => [kind, l && { ...l, last: run(l.last), last_ok: run(l.last_ok), first_change_after: run(l.first_change_after) }])),
      failure_chains: audit.failure_chains.map((c) => ({ ...c, failures: c.failures.map((row) => row + offset), next_same_tool: c.next_same_tool === null ? null : c.next_same_tool + offset })) },
    docs: result.docs.map((doc) => ({ ...doc, citations: doc.citations.map((c) => ({ ...c, row_id: c.row_id === null ? null : c.row_id + offset })) })),
  };
}

/** Below this many attempts the bundle pass runs in this process (workers come from EBO_WORKERS, as for validation). */
const ATTEMPT_PARALLEL = 32;

/**
 * Processes attempts in order. With many attempts and more than one worker, worker processes run them ahead (at
 * most two per worker in flight) while results are yielded in job order.
 */
async function* processAttempts(jobs: readonly AttemptJob[], requested?: number): AsyncGenerator<AttemptResult> {
  // An explicit worker count (a test, or an operator's choice) applies at any size; the default only for many attempts.
  const workers = requested ?? validationWorkers();
  if (workers <= 1 || (requested === undefined && jobs.length < ATTEMPT_PARALLEL)) {
    for (const job of jobs) yield await processAttempt(job);
    return;
  }
  const script = fileURLToPath(new URL("./atlas-attempt-worker.js", import.meta.url));
  const pool = Array.from({ length: Math.min(workers, jobs.length) }, () => fork(script, [], { stdio: ["ignore", "inherit", "inherit", "ipc"], serialization: "advanced" }));
  const pending = new Map<number, { resolve: (result: AttemptResult) => void; reject: (error: Error) => void }>();
  const results = new Map<number, Promise<AttemptResult>>();
  const idle = [...pool];
  let next = 0;
  for (const worker of pool) {
    worker.on("message", (reply: { index: number; result?: AttemptResult; error?: string }) => {
      const waiting = pending.get(reply.index)!;
      pending.delete(reply.index);
      idle.push(worker);
      if (reply.error !== undefined) waiting.reject(new Error(reply.error)); else waiting.resolve(reply.result!);
      dispatch();
    });
    worker.once("exit", (code) => { if (code !== 0 && code !== null) for (const { reject } of pending.values()) reject(new Error(`An attempt worker exited with ${String(code)}.`)); });
  }
  let written = 0;
  const dispatch = () => {
    while (idle.length && next < jobs.length && next - written < pool.length * 2) {
      const index = next++, worker = idle.pop()!;
      results.set(index, new Promise<AttemptResult>((resolve, reject) => pending.set(index, { resolve, reject })));
      results.get(index)!.catch(() => undefined);
      worker.send({ index, job: jobs[index] });
    }
  };
  try {
    dispatch();
    for (; written < jobs.length; written++) {
      if (!results.has(written)) dispatch();
      const result = await results.get(written)!;
      results.delete(written);
      yield result;
      dispatch();
    }
  } finally {
    for (const worker of pool) worker.kill();
  }
}

/** Above this many attempts, viewer documents are split per attempt (assessments, audits, lane series). */
export const SPLIT_ATTEMPTS = 2000;

type CertifiedCell = { group: Record<string, string>; card: string; family: string; mode: string; producer: string; counts: Record<string, number>; denominator: number;
  values?: Record<string, number>; assertions: string[] };

/**
 * JSON.stringify(value, null, indent), written in chunks: a large study's report or index can exceed the longest
 * string V8 allows, and a chunked write never builds it whole.
 */
export function writeJsonFile(path: string, value: unknown, indent = 0): void {
  const fd = openSync(path, "w");
  let buffer = "";
  const emit = (text: string) => { buffer += text; if (buffer.length > 1 << 20) { writeSync(fd, buffer); buffer = ""; } };
  const pad = (depth: number) => (indent ? `\n${" ".repeat(indent * depth)}` : "");
  const write = (item: unknown, depth: number, inArray: boolean): void => {
    if (item !== null && typeof item === "object" && typeof (item as { toJSON?: unknown }).toJSON === "function") item = (item as { toJSON: () => unknown }).toJSON();
    if (Array.isArray(item)) {
      if (!item.length) { emit("[]"); return; }
      emit("[");
      item.forEach((element, i) => { if (i) emit(","); emit(pad(depth + 1)); write(element, depth + 1, true); });
      emit(`${pad(depth)}]`);
    } else if (item !== null && typeof item === "object") {
      const entries = Object.entries(item).filter(([, v]) => v !== undefined && typeof v !== "function" && typeof v !== "symbol");
      if (!entries.length) { emit("{}"); return; }
      emit("{");
      entries.forEach(([key, v], i) => { if (i) emit(","); emit(`${pad(depth + 1)}${JSON.stringify(key)}:${indent ? " " : ""}`); write(v, depth + 1, false); });
      emit(`${pad(depth)}}`);
    } else {
      const text = JSON.stringify(item);
      emit(text === undefined ? (inArray ? "null" : "null") : text);
    }
  };
  try {
    write(value, 0, false);
    if (indent) emit("\n");
    writeSync(fd, buffer);
  } finally { closeSync(fd); }
}

const CLOUD_STRINGS = ["unit_id", "attempt_id", "unit_kind", "subkind", "role", "episode_id", "model_id", "harness_id", "task_id", "trial_id", "condition",
  "terminal_state", "tool_name", "tool_kind", "command_head", "check_kind", "target", "status", "error_signature", "first_event_key", "embed_text"] as const;
const CLOUD_NUMBERS = ["seq", "exit_code", "duration_seconds", "input_chars", "output_chars", "output_lines", "lines_added", "lines_removed", "tool_count",
  "error_count", "event_count", "t0_ms", "t1_ms"] as const;
const CLOUD_LISTS = ["check_kinds", "writes", "occurrences", "cited_assessments"] as const;
const FAMILY: Record<string, string> = { message: "messages", compaction: "messages", episode: "episodes", tool: "tools" };

/** Cloud rows go to a staging file as they are made; only the texts to embed stay in memory. */
class CloudWriter {
  rows = 0;
  readonly texts: string[] = [];
  readonly families: string[] = [];
  private fd: number;
  constructor(private readonly path: string) { this.fd = openSync(path, "w"); }
  push(row: Record<string, unknown>): void {
    const out: Record<string, unknown> = { row_id: row.row_id, family: FAMILY[String(row.unit_kind)] ?? "tools", timed: row.timed === true, cited: row.cited === true };
    for (const key of CLOUD_STRINGS) out[key] = typeof row[key] === "string" ? row[key] : null;
    for (const key of CLOUD_NUMBERS) out[key] = typeof row[key] === "number" ? row[key] : null;
    for (const key of CLOUD_LISTS) out[key] = Array.isArray(row[key]) ? row[key] : [];
    writeSync(this.fd, `${JSON.stringify(out)}\n`);
    this.texts.push(String(row.embed_text ?? ""));
    this.families.push(String(out.family));
    this.rows += 1;
  }
  finish(): { path: string; rows: number } { closeSync(this.fd); return { path: this.path, rows: this.rows }; }
}

/** units.arrow from the staged cloud rows, one record batch per block of rows, so the table is never whole in memory. */
/** Above this many cloud units a build-time layout also writes the compact cloud (clusters, dictionaries, short labels). */
export const COMPACT_UNITS = 1_000_000;
/** Compact cloud columns stored as one dictionary each: low-cardinality strings that repeat on every unit. */
const COMPACT_DICTIONARIES = ["attempt_id", "condition", "model_id", "harness_id", "task_id", "trial_id", "unit_kind", "family", "subkind", "role", "tool_name", "tool_kind",
  "command_head", "check_kind", "status", "terminal_state", "target", "error_signature", "cluster_label"] as const;
/** The compact cloud's text label: the start of a unit's embedded text, enough for a tooltip or table row. */
export const COMPACT_LABEL_CHARS = 96;
type CompactCloud = { clusterId: Int32Array; clusterOf: (id: number) => string | null; labels: ReturnType<typeof clusterCloud>["labels"]; dictionaries: Map<string, Map<string, number>> };

/**
 * Writes the compact cloud (units.arrow and labels.json) from staged cloud rows (JSON lines in cloud row order) and
 * their build-time positions. The bundle build calls it for a large cloud; scale tests call it directly.
 */
export async function writeCompactCloudFiles(source: { path: string; rows: number }, xy: Float32Array, families: readonly string[], outputRoot: string): Promise<void> {
  const compact = compactCloud(source, xy, families);
  writeJsonFile(join(outputRoot, "labels.json"), compact.labels);
  await writeCompactCloudArrow(source, join(outputRoot, "units.arrow"), xy, compact);
}

/** One pass over the staged cloud rows: their facets for clustering and the dictionary of each repeated string column. */
function compactCloud(source: { path: string; rows: number }, xy: Float32Array, families: readonly string[]): CompactCloud {
  const index = new FacetIndex(), dictionaries = new Map<string, Map<string, number>>(COMPACT_DICTIONARIES.map((key) => [key, new Map()]));
  for (const [, line] of readFileLines(source.path)) {
    if (!line) continue;
    const u = JSON.parse(line) as Record<string, unknown>;
    index.add({ family: String(u.family), unit_kind: String(u.unit_kind), text: clipText(String(u.embed_text ?? ""), 2000), tool_kind: u.tool_kind as string | null,
      command_head: u.command_head as string | null, check_kind: u.check_kind as string | null, target: u.target as string | null, status: u.status as string | null, occurrences: u.occurrences as string[] });
    for (const key of COMPACT_DICTIONARIES) {
      const value = u[key], dictionary = dictionaries.get(key)!;
      if (typeof value === "string" && !dictionary.has(value)) dictionary.set(value, dictionary.size);
    }
  }
  const clusters = clusterCloud(xy, families, index);
  const labelDictionary = dictionaries.get("cluster_label")!;
  for (const id of new Set(clusters.clusterId)) { const label = clusters.clusterOf(id); if (label !== null && !labelDictionary.has(label)) labelDictionary.set(label, labelDictionary.size); }
  return { ...clusters, dictionaries };
}

async function writeCloudArrow(source: { path: string; rows: number }, path: string,
  layout?: { xy: Float32Array; neighborIds: Int32Array; neighborDistances: Float32Array; k: number }, compact?: CompactCloud): Promise<void> {
  if (compact && layout) return writeCompactCloudArrow(source, path, layout.xy, compact);
  // A build-time layout adds what the viewer would otherwise compute: positions and each unit's nearest neighbors.
  const neighborType = new Struct([new Field("ids", new List(new Field("item", new Int32(), true)), true), new Field("distances", new List(new Field("item", new Float32(), true)), true)]);
  const placed = (rows: Array<Record<string, unknown>>) => {
    if (!layout) return {} as Record<string, never>;
    const at = rows.map((u) => Number(u.row_id)), k = layout.k;
    return {
      x: makeVector(Float32Array.from(at, (row) => layout.xy[2 * row]!)), y: makeVector(Float32Array.from(at, (row) => layout.xy[2 * row + 1]!)),
      neighbors: vectorFromArray(at.map((row) => {
        const ids: number[] = [], distances: number[] = [];
        for (let j = 0; j < k; j++) { const id = layout.neighborIds[row * k + j]!; if (id >= 0) { ids.push(id); distances.push(layout.neighborDistances[row * k + j]!); } }
        return { ids, distances };
      }), neighborType),
    };
  };
  const writer = new RecordBatchStreamWriter({ autoDestroy: false });
  const out = createWriteStream(path);
  writer.toNodeStream().pipe(out);
  const batch = (rows: Array<Record<string, unknown>>) => new Table<any>({
    row_id: makeVector(Int32Array.from(rows.map((u) => Number(u.row_id)))),
    ...Object.fromEntries(CLOUD_STRINGS.map((key) => [key, vectorFromArray(rows.map((u) => u[key] as string | null), new Utf8())])),
    family: vectorFromArray(rows.map((u) => String(u.family)), new Utf8()),
    ...Object.fromEntries(CLOUD_NUMBERS.map((key) => [key, vectorFromArray(rows.map((u) => u[key] as number | null), new Float64())])),
    timed: vectorFromArray(rows.map((u) => u.timed === true), new Bool()),
    cited: vectorFromArray(rows.map((u) => u.cited === true), new Bool()),
    ...Object.fromEntries(CLOUD_LISTS.map((key) => [key, vectorFromArray(rows.map((u) => [...(u[key] as string[])]), new List(new Field("item", new Utf8(), true)))])),
    ...placed(rows),
  });
  let pending: Array<Record<string, unknown>> = [];
  const flush = async () => {
    for (const recordBatch of batch(pending).batches) writer.write(recordBatch);
    pending = [];
    if (out.writableNeedDrain) await new Promise((accept) => out.once("drain", accept));
  };
  for (const [, line] of readFileLines(source.path)) {
    if (!line) continue;
    pending.push(JSON.parse(line) as Record<string, unknown>);
    if (pending.length === 65536) await flush();
  }
  if (pending.length || source.rows === 0) await flush();
  writer.finish(); writer.close();
  await finished(out);
}

/**
 * The compact cloud: the columns the viewer filters, colours, brushes and queries on, each repeated string as codes
 * into one dictionary for the whole table (DuckDB reads them as ENUM columns), a short text label, the build-time
 * positions and clusters. Full texts stay in the tables and native records.
 */
async function writeCompactCloudArrow(source: { path: string; rows: number }, path: string, xy: Float32Array, compact: CompactCloud): Promise<void> {
  const writer = new RecordBatchStreamWriter({ autoDestroy: false });
  const out = createWriteStream(path);
  writer.toNodeStream().pipe(out);
  const dictionaryVectors = new Map([...compact.dictionaries].map(([key, dictionary], id) => [key, { id, values: vectorFromArray([...dictionary.keys()], new Utf8()) }]));
  const coded = (key: string, values: Array<string | null>) => {
    const { id, values: dictionary } = dictionaryVectors.get(key)!, codes = compact.dictionaries.get(key)!;
    const nullBitmap = new Uint8Array(Math.ceil(values.length / 8));
    const data = Int32Array.from(values, (value, i) => { if (value === null) return 0; nullBitmap[i >> 3]! |= 1 << (i & 7); return codes.get(value)!; });
    return makeVector(makeData({ type: new Dictionary(new Utf8(), new Int32(), id), length: values.length, nullCount: values.filter((v) => v === null).length, nullBitmap, data, dictionary }));
  };
  const int = (rows: Array<Record<string, unknown>>, key: string) => vectorFromArray(rows.map((u) => (typeof u[key] === "number" ? Math.trunc(u[key] as number) : null)), new Int32());
  const batch = (rows: Array<Record<string, unknown>>) => {
    const at = rows.map((u) => Number(u.row_id));
    return new Table<any>({
      row_id: makeVector(Int32Array.from(at)),
      ...Object.fromEntries(COMPACT_DICTIONARIES.map((key) => [key, coded(key, key === "cluster_label"
        ? at.map((row) => compact.clusterOf(compact.clusterId[row]!)) : rows.map((u) => (typeof u[key] === "string" ? u[key] as string : null)))])),
      label: vectorFromArray(rows.map((u) => clipText(String(u.embed_text ?? ""), COMPACT_LABEL_CHARS)), new Utf8()),
      seq: int(rows, "seq"), exit_code: int(rows, "exit_code"), event_count: int(rows, "event_count"),
      ...Object.fromEntries(["duration_seconds", "t0_ms", "t1_ms"].map((key) => [key, vectorFromArray(rows.map((u) => u[key] as number | null), new Float64())])),
      timed: vectorFromArray(rows.map((u) => u.timed === true), new Bool()),
      cited: vectorFromArray(rows.map((u) => u.cited === true), new Bool()),
      ...Object.fromEntries(["occurrences", "cited_assessments", "writes"].map((key) => [key, vectorFromArray(rows.map((u) => [...(u[key] as string[])]), new List(new Field("item", new Utf8(), true)))])),
      x: makeVector(Float32Array.from(at, (row) => xy[2 * row]!)), y: makeVector(Float32Array.from(at, (row) => xy[2 * row + 1]!)),
      cluster_id: makeVector(Int32Array.from(at, (row) => compact.clusterId[row]!)),
    });
  };
  let pending: Array<Record<string, unknown>> = [];
  const flush = async () => {
    for (const recordBatch of batch(pending).batches) writer.write(recordBatch);
    pending = [];
    if (out.writableNeedDrain) await new Promise((accept) => out.once("drain", accept));
  };
  for (const [, line] of readFileLines(source.path)) {
    if (!line) continue;
    pending.push(JSON.parse(line) as Record<string, unknown>);
    if (pending.length === 65536) await flush();
  }
  if (pending.length || source.rows === 0) await flush();
  writer.finish(); writer.close();
  await finished(out);
}

/** A file's lines with 1-based numbers, read in chunks. */
function* readFileLines(path: string): Generator<[number, string]> {
  const fd = openSync(path, "r"), decoder = new StringDecoder("utf8"), chunk = Buffer.allocUnsafe(1 << 20);
  let pending = "", number = 0, size: number;
  try {
    while ((size = readSync(fd, chunk, 0, chunk.length, null)) !== 0) {
      const parts = (pending + decoder.write(chunk.subarray(0, size))).split("\n");
      pending = parts.pop()!;
      for (const part of parts) yield [++number, part];
    }
    pending += decoder.end();
    if (pending) yield [++number, pending];
  } finally { closeSync(fd); }
}

/**
 * The large-bundle assessment index: one row per card result with its identity and verdict, each repeated string
 * column stored as indexes into a dictionary that assessments.json carries. Details stay in assessments/<attempt>.json.
 */
class AssessmentIndex {
  private readonly ids: string[] = [];
  private readonly attempts: number[] = [];
  private readonly probability: number[] = [];
  private readonly confidence: number[] = [];
  private readonly citations: number[] = [];
  private readonly columns = Object.fromEntries((["card", "mode", "producer", "outcome", "value", "direction", "review", "included", "disputed"] as const)
    .map((name) => [name, { values: [] as number[], dictionary: new Map<string, number>() }])) as Record<"card" | "mode" | "producer" | "outcome" | "value" | "direction" | "review" | "included" | "disputed", { values: number[]; dictionary: Map<string, number> }>;
  private code(column: keyof AssessmentIndex["columns"], value: string | null) {
    const { values, dictionary } = this.columns[column];
    if (value === null) { values.push(-1); return; }
    let code = dictionary.get(value);
    if (code === undefined) { code = dictionary.size; dictionary.set(value, code); }
    values.push(code);
  }
  push(doc: { id: string; card: string; mode: string; producer: string; outcome: string; value: string | null; direction: string | null; review: string; probability: number | null; confidence: number | null;
    cohorts: Record<string, { included?: boolean; disputed?: boolean }>; citations: unknown[] }, attempt: number): void {
    this.ids.push(doc.id); this.attempts.push(attempt); this.citations.push(doc.citations.length);
    this.probability.push(doc.probability ?? Number.NaN); this.confidence.push(doc.confidence ?? Number.NaN);
    for (const column of ["card", "mode", "producer", "outcome", "value", "direction", "review"] as const) this.code(column, doc[column]);
    const cohorts = Object.entries(doc.cohorts);
    this.code("included", cohorts.filter(([, flag]) => flag.included !== false).map(([id]) => id).sort().join(","));
    this.code("disputed", cohorts.filter(([, flag]) => flag.disputed === true).map(([id]) => id).sort().join(","));
  }
  async write(path: string, file: string) {
    const writer = new RecordBatchStreamWriter({ autoDestroy: false });
    const out = createWriteStream(path);
    writer.toNodeStream().pipe(out);
    for (let start = 0; start < Math.max(1, this.ids.length); start += 1 << 18) {
      const end = Math.min(this.ids.length, start + (1 << 18));
      const table = new Table({
        id: vectorFromArray(this.ids.slice(start, end), new Utf8()),
        attempt: makeVector(Int32Array.from(this.attempts.slice(start, end))),
        probability: makeVector(Float32Array.from(this.probability.slice(start, end))),
        confidence: makeVector(Float32Array.from(this.confidence.slice(start, end))),
        citations: makeVector(Int32Array.from(this.citations.slice(start, end))),
        ...Object.fromEntries(Object.entries(this.columns).map(([name, { values }]) => [name, makeVector(Int32Array.from(values.slice(start, end)))])),
      });
      for (const recordBatch of table.batches) writer.write(recordBatch);
      if (out.writableNeedDrain) await new Promise((accept) => out.once("drain", accept));
    }
    writer.finish(); writer.close();
    await finished(out);
    return { file, rows: this.ids.length, attempts: "attempts", dictionaries: Object.fromEntries(Object.entries(this.columns).map(([name, { dictionary }]) => [name, [...dictionary.keys()]])) };
  }
}

/** One assertion's rows in the assessments, citations and claims tables, with their edges. */
function writeAssessmentRows(assertion: BehaviorAssertion, slim: { digest: string; review: string }, eventKeys: ReadonlySet<string>,
  stream: (name: string, row: Row) => void, edge: (srcType: string, srcId: unknown, rel: unknown, dstType: string, dstId: unknown) => void): void {
  const llm = isDecisionModelAssertion(assertion) ? undefined : assertion;
  const j = assertion.judgment;
  const card = resolveBehaviorCard(assertion.behavior);
  // A decision model's deciding probability: that the card applies (dimension) or is present.
  const probability = j.basis !== "probabilities" ? null : "applies" in j.probabilities ? j.probabilities.applies : j.probabilities.present;
  const citations = llm?.judgment.citations ?? [];
  const claims = llm?.judgment.claims ?? [];
  stream("assessments", { assertion_id: assertion.id, attempt_id: assertion.attemptId, run_id: assertion.runId, card_id: assertion.behavior.cardId,
    family_id: card.family, ontology_version: assertion.behavior.ontologyVersion, producer_mode: assertion.producer.mode,
    rubric_id: llm?.rubric.id ?? null, rubric_version: llm?.rubric.version ?? null,
    evaluator_id: `${assertion.producer.provider}/${assertion.producer.model}`, evaluator_version: assertion.producer.version, evaluator_config_digest: assertion.producer.configurationDigest ?? null,
    verdict: j.verdict, value: j.verdict === "present" ? j.value ?? null : null, direction: behaviorDirection(card, j) ?? null,
    confidence: j.basis === "probabilities" || j.verdict === "unknown" ? null : j.confidence.value,
    confidence_scale: j.basis === "probabilities" || j.verdict === "unknown" ? null : j.confidence.scale,
    probability, probabilities_json: j.basis === "probabilities" ? JSON.stringify(j.probabilities) : null, thresholds_json: j.basis === "probabilities" ? JSON.stringify(j.thresholds) : null,
    evidence_json: JSON.stringify(assertion.evidence), review: slim.review, rationale: llm?.judgment.rationale ?? null,
    alternative_explanation: llm?.judgment.alternativeExplanation ?? null, assertion_digest: slim.digest, dataset_digest: assertion.dataset.digest,
    citation_count: citations.length, claim_count: claims.length });
  edge("assessment", assertion.id, "about", "attempt", assertion.attemptId);
  citations.forEach((citation, ordinal) => {
    const key = `${assertion.attemptId}/${citation.eventId}`;
    stream("citations", { assertion_id: assertion.id, ordinal, attempt_id: assertion.attemptId, event_id: citation.eventId, event_key: key,
      occurrence_id: citation.occurrenceId ?? null, native_artifact: citation.nativeReference.artifactId, native_locator: citation.nativeReference.recordLocator,
      resolved: eventKeys.has(key) });
    edge("assessment", assertion.id, "cites", "event", key);
  });
  claims.forEach((claim, ordinal) => {
    stream("claims", { assertion_id: assertion.id, claim_id: claim.id, ordinal, text: claim.text, workspace: claim.workspace,
      citation_event_keys: JSON.stringify(claim.citations.map(({ eventId }) => `${assertion.attemptId}/${eventId}`)) });
  });
}

/** An id used as a file name must be one path segment of safe characters. */
function fileName(id: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u.test(id)) throw new Error(`Id ${JSON.stringify(id)} cannot name a bundle file (letters, digits, ".", "_", "-").`);
  return id;
}

/** Recompute every listed file's size and digest; report changed, missing and unlisted files. */
export function verifyAtlasBundle(root: string): { ok: boolean; changed: string[]; missing: string[]; unlisted: string[] } {
  const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")) as AtlasBundleManifest;
  const errors = validateArtifact("atlas bundle", manifest);
  if (errors.length) throw new Error(errors.map(({ field, message }) => `${field}: ${message}`).join("\n"));
  for (const { path } of manifest.files) assertContainedPath(path);
  const listed = new Set(manifest.files.map(({ path }) => path));
  const walk = (dir: string): string[] => readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);
  const present = walk("").map((p) => p.replace(/\\/gu, "/")).filter((p) => p !== "manifest.json");
  const missing = manifest.files.filter(({ path }) => !existsSync(join(root, path))).map(({ path }) => path);
  const changed = manifest.files.filter(({ path, bytes, sha256: digest }) => existsSync(join(root, path))
    && (statSync(join(root, path)).size !== bytes || fileSha256(join(root, path)) !== digest)).map(({ path }) => path);
  const unlisted = present.filter((p) => !listed.has(p));
  return { ok: !missing.length && !changed.length && !unlisted.length, changed, missing, unlisted };
}

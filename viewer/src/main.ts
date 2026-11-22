// EBO Atlas viewer: Embedding Atlas + EBO panels on one Mosaic coordinator over DuckDB-WASM.
// Data: one Atlas bundle (ebo.atlas-bundle/v2) at ?bundle=<url> (default ./bundle/, as `ebo atlas serve` and packets
// lay it out). Other parameters: labels=facet|auto, color=<column>|none, panel=<tab>.
// Everything that changes on screen goes through the command registry (registry.ts); the state serializes to the URL.
import "./tokens.css";
import "./style.css";
import * as duckdb from "@duckdb/duckdb-wasm";
import baseWasm from "@duckdb/duckdb-wasm/dist/duckdb-base.wasm?url";
import baseWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-base.worker.js?url";
import { Coordinator, wasmConnector } from "@uwdata/mosaic-core";
import { EmbeddingAtlas } from "embedding-atlas";
import { ClusterArmPanel, rowsOf } from "./enrichment";
import { setUnitTextColumn, shortId, SwimlanesPanel, type LanesData } from "./lanes";

/** The most cloud table (Arrow bytes) the viewer loads: DuckDB-WASM's 4 GB address space less room for queries. */
const CLOUD_BUDGET_BYTES = 2.5e9;
const COMPACT_UNITS_HINT = "1,000,000";
import { STOP_WORDS } from "./stopwords";
import { LEGEND_LIMIT, unselectableLegendCategories } from "./legend";
import { ClaimsPanel, Drawer, Evidence, expandAssessmentIndex, MatrixPanel, type AssessDoc, type AuditDoc, type ClaimsDoc, type DrawerView } from "./p3";
import { FiguresPanel, type ViewsDoc } from "./views";
import { prepareCloud } from "./layout";
import { RecordBatch, RecordBatchReader, Table, tableFromArrays, tableToIPC } from "apache-arrow";
import {
  commandRunning, decodeState, onCommandBoundary, describable, describe, encodeState, getState, listCommands, provide, recordChange, register, run, setState, subscribe, target,
  type CommandEvent, type Json,
} from "./registry";

const params = new URLSearchParams(location.search);
const bundleUrl = new URL(params.get("bundle") ?? "./bundle/", location.href).href.replace(/\/?$/, "/");
const labelMode = params.get("labels") ?? "facet";
const colorBy = params.get("color") ?? "condition"; // any column name; "none" for uncolored points
const TABS = ["clusters", "lanes", "assessments", "claims", "figures"] as const;
type Tab = (typeof TABS)[number];
const initialPanel = (TABS as readonly string[]).includes(params.get("panel") ?? "") ? params.get("panel") as Tab : "clusters";

const statusEl = document.getElementById("status")!;
const status = (msg: string, error = false) => {
  statusEl.textContent = msg;
  statusEl.classList.toggle("error", error);
};
const dark = () => matchMedia("(prefers-color-scheme: dark)").matches;
const file = (name: string) => new URL(name, bundleUrl).href;
const getJson = async <T,>(name: string): Promise<T | null> => { try { const r = await fetch(file(name)); return r.ok ? await r.json() : null; } catch { return null; } };

/** The base DuckDB-WASM build works without cross-origin isolation. */
async function initDuckDB(): Promise<duckdb.AsyncDuckDB> {
  const worker = new Worker(baseWorker, { type: "module" });
  const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING), worker);
  await db.instantiate(baseWasm);
  return db;
}

type EmbeddingSpec = { file: string; provider?: string; model?: string; revision?: string; dimensions: number;
  run?: { texts: number; distinct: number; cached: number; embedded: number; seconds: number; runtime?: { device: string; deviceName?: string; dtype: string; batchSize: number; textsPerSecond: number | null; warning?: string } } };
interface BundleManifest { schemaVersion?: string; title?: string; study?: { id?: string; title?: string }; cloud?: { units?: number; embeddings?: EmbeddingSpec }; derivedFrom?: { variant: string } }

/** How the cloud's vectors were made, in words: the header and describe() say the same thing. */
export function embeddingSummary(spec: EmbeddingSpec | undefined, derived?: string): string {
  if (!spec) return "Embeddings: not recorded in this bundle";
  const what = spec.provider === "embeddinggemma" ? `EmbeddingGemma 2 (${spec.model ?? "model unrecorded"})`
    : spec.provider === "hashed-tfidf" || spec.provider === "local" ? "hashed TF-IDF (offline, no model)" : `${spec.provider ?? "unknown provider"} ${spec.model ?? ""}`.trim();
  const runtime = spec.run?.runtime;
  return `Embeddings: ${what} · ${spec.dimensions} dimensions${runtime ? ` · ${runtime.device}${runtime.deviceName ? ` (${runtime.deviceName})` : ""}` : ""}${derived ? ` · recomputed for the ${derived} packet` : ""}`;
}

async function main() {
  const manifest = await getJson<BundleManifest>("manifest.json");
  const title = manifest?.title ?? manifest?.study?.title ?? "Atlas bundle";
  document.getElementById("bundle-title")!.textContent = title;
  const embeddings = manifest?.cloud?.embeddings, embeddingText = embeddingSummary(embeddings, manifest?.derivedFrom?.variant);
  const embeddingEl = document.getElementById("bundle-embeddings")!;
  embeddingEl.textContent = embeddingText;
  const pass = embeddings?.run;
  if (pass) embeddingEl.title = [`${pass.texts.toLocaleString()} units, ${pass.distinct.toLocaleString()} distinct texts (${pass.cached.toLocaleString()} from the cache, ${pass.embedded.toLocaleString()} embedded)`,
    pass.runtime ? `${pass.runtime.dtype}, batch ${pass.runtime.batchSize}, ${pass.runtime.textsPerSecond ?? "?"} texts/s` : "", embeddings?.revision ? `revision ${embeddings.revision}` : "", pass.runtime?.warning ?? ""].filter(Boolean).join("\n");
  describable("bundle", { describe: () => ({ summary: `${title}. ${embeddingText}.`,
    data: { title, units: manifest?.cloud?.units ?? null, embeddings: embeddings ? { provider: embeddings.provider ?? null, model: embeddings.model ?? null, revision: embeddings.revision ?? null,
      dimensions: embeddings.dimensions, run: (embeddings.run ?? null) as Json } : null, derivedFrom: manifest?.derivedFrom?.variant ?? null } }) });
  document.title = `${title} · EBO Atlas`;

  status("Starting DuckDB…");
  const db = await initDuckDB();
  const coordinator = new Coordinator(wasmConnector({ duckdb: db }));

  status("Loading units…");
  // The cloud table must fit DuckDB-WASM's 4 GB address space with room to query it. A bundle over that budget is
  // reported by table and size here rather than failing somewhere inside the load.
  const unitsBytes = (manifest as { files?: Array<{ path: string; bytes: number }> } | null)?.files?.find(({ path }) => path === "units.arrow")?.bytes;
  if (unitsBytes !== undefined && unitsBytes > CLOUD_BUDGET_BYTES) {
    throw new Error(`The cloud table (units.arrow) is ${(unitsBytes / 1e9).toFixed(1)} GB, ${((unitsBytes - CLOUD_BUDGET_BYTES) / 1e9).toFixed(1)} GB over the ${(CLOUD_BUDGET_BYTES / 1e9).toFixed(1)} GB this viewer can hold. Rebuild the bundle with a build-time layout, which writes the compact cloud above ${COMPACT_UNITS_HINT} units.`);
  }
  // Arrow IPC needs no DuckDB extensions, so the viewer also works offline and from packets opened on disk.
  const resp = await fetch(file("units.arrow"));
  if (!resp.ok) throw new Error(`units.arrow not found in the bundle at ${bundleUrl}`);
  const conn = await db.connect();
  const loadFailed = (error: unknown) => new Error(`Loading the cloud table (units${unitsBytes === undefined ? "" : `, ${(unitsBytes / 1e9).toFixed(2)} GB of Arrow`}) into DuckDB failed: ${error instanceof Error ? error.message : String(error)}`);
  let cloud: { labels: Awaited<ReturnType<typeof prepareCloud>>["labels"] };
  if ((manifest as { cloud?: { layout?: { compact?: boolean } } } | null)?.cloud?.layout?.compact) {
    // A compact cloud arrives laid out and clustered. It is streamed into DuckDB a slice at a time: a browser cannot
    // hold one multi-gigabyte buffer, and the table needs no work here.
    try {
      const reader = await RecordBatchReader.from(resp.body!);
      let pending: RecordBatch[] = [], rows = 0, loaded = 0, create = true;
      const flush = async () => {
        await conn.insertArrowFromIPCStream(tableToIPC(new Table(pending), "stream"), { name: "units", create });
        create = false; loaded += rows; pending = []; rows = 0;
        status(`Loading units… ${loaded.toLocaleString()}`);
      };
      for await (const batch of reader) { pending.push(batch); rows += batch.numRows; if (rows >= 1 << 19) await flush(); }
      if (pending.length || create) await flush();
    } catch (error) { throw loadFailed(error); }
    cloud = { labels: null };
  } else {
    const prepared = await prepareCloud(new Uint8Array(await resp.arrayBuffer()), async () => {
      const spec = (manifest as { cloud?: { embeddings?: { file: string; dimensions: number } } } | null)?.cloud?.embeddings;
      if (!spec) return null;
      const r = await fetch(file(spec.file));
      return r.ok ? { data: new Float32Array(await r.arrayBuffer()), dimensions: spec.dimensions } : null;
    }, status);
    try { await conn.insertArrowFromIPCStream(prepared.ipc, { name: "units", create: true }); } catch (error) { throw loadFailed(error); }
    cloud = prepared;
  }
  const unitColumns = new Set((await conn.query("DESCRIBE units")).toArray().map((row) => String(row.toJSON().column_name)));
  await conn.close();
  // A compact cloud keeps a short label in place of the full text and leaves neighbors out.
  const textColumn = unitColumns.has("embed_text") ? "embed_text" : "label";
  const neighborsColumn = unitColumns.has("neighbors") ? "neighbors" : undefined;
  setUnitTextColumn(textColumn);

  // Embedding Atlas labels are { x, y, content, level, priority }; labels.json stores the text as `text`.
  let labels: { x: number; y: number; content: string; level?: number; priority?: number }[] | null = null;
  if (labelMode === "facet") {
    const raw = cloud.labels ?? await getJson<{ x: number; y: number; text?: string; content?: string; level?: number; priority?: number }[]>("labels.json");
    labels = raw?.length ? raw.map((l) => ({ x: l.x, y: l.y, content: (("content" in l ? l.content : undefined) ?? l.text ?? "").replace(/`/g, ""), level: l.level ?? 0, priority: l.priority ?? 0 })) : null;
  }
  const n = rowsOf(await coordinator.query(`SELECT count(*) AS n FROM units`))[0].n;
  const readyStatus = `${Number(n).toLocaleString()} units${labels ? " · facet labels" : " · auto labels"}`;
  status(readyStatus);

  // bottom panel: tabs over the shared table
  const host = document.getElementById("panel")!;
  const tabLabels: Record<Tab, string> = { clusters: "Clusters × arm", lanes: "Swimlanes", assessments: "Assessments", claims: "Claims", figures: "Figures" };
  host.innerHTML = `
    <div class="tabs" role="tablist" aria-label="Panels">
      ${TABS.map((t) => `<button role="tab" id="tab-${t}" data-tab="${t}" ${target("openTab", t)} aria-controls="body-${t}">${tabLabels[t]}</button>`).join("")}
      <button class="focus-btn" data-focus ${target("setPanelFocus")} title="Reading mode: shrink the cloud so the panel gets the window">Expand panel</button>
    </div>
    ${TABS.map((t) => `<div class="tab-body" id="body-${t}" role="tabpanel" aria-labelledby="tab-${t}"></div>`).join("")}`;
  // The cloud highlight is viewer state (undo, URL), not only a rendering detail.
  let highlighted: number[] | null = null;
  const highlight = (ids: number[] | null) => { highlighted = ids?.length ? [...ids] : null; atlas.update({ highlight: highlighted }); };
  const lanesData = await getJson<LanesData>("lanes.json");
  const [assessDoc, auditDoc, claimsDoc, viewsDoc] = await Promise.all([
    getJson<AssessDoc>("assessments.json"), getJson<AuditDoc>("audit.json"), getJson<ClaimsDoc>("claims.json"), getJson<ViewsDoc>("views.json")]);
  if (assessDoc?.index) {
    // A large bundle indexes its card results; each attempt's details load when a view of it opens.
    status(`Loading ${assessDoc.index.rows.toLocaleString()} card results…`);
    const r = await fetch(file(assessDoc.index.file));
    assessDoc.assessments = r.ok ? expandAssessmentIndex(assessDoc, new Uint8Array(await r.arrayBuffer())) : [];
    status(`${readyStatus} · ${assessDoc.assessments.length.toLocaleString()} card results`);
  }
  if (lanesData?.split) lanesData.usage ??= {};
  if (assessDoc && viewsDoc?.views.length) {
    // the `assessments` host table view specs may query
    const xs = assessDoc.assessments;
    const c2 = await db.connect();
    // IPC bytes, not a Table object: DuckDB-WASM bundles its own apache-arrow. Built column by column: a large bundle
    // has millions of results.
    if (xs.length) await c2.insertArrowFromIPCStream(tableToIPC(tableFromArrays({
      id: xs.map((x) => x.id), attempt_id: xs.map((x) => x.attempt_id), condition: xs.map((x) => x.condition), task_id: xs.map((x) => x.task_id), trial_id: xs.map((x) => x.trial_id),
      mode: xs.map((x) => x.mode), card: xs.map((x) => x.card), family: xs.map((x) => x.family), outcome: xs.map((x) => x.outcome), value: xs.map((x) => x.value ?? null),
      direction: xs.map((x) => x.direction ?? null), confidence: xs.map((x) => x.confidence ?? null), probability: xs.map((x) => x.probability ?? null),
      citations: Int32Array.from(xs, (x) => x.citationCount ?? x.citations.length), in_primary: xs.map((x) => Boolean(x.cohorts?.primary && x.cohorts.primary.included !== false)),
    }), "stream"), { name: "assessments", create: true });
    else await c2.query("CREATE TABLE assessments (id VARCHAR, attempt_id VARCHAR, condition VARCHAR, task_id VARCHAR, trial_id VARCHAR, mode VARCHAR, card VARCHAR, family VARCHAR, outcome VARCHAR, value VARCHAR, direction VARCHAR, confidence DOUBLE, probability DOUBLE, citations INTEGER, in_primary BOOLEAN)");
    await c2.close();
  }

  let tab: Tab = "clusters";
  const lanes = lanesData ? new SwimlanesPanel(document.getElementById("body-lanes")!, coordinator, lanesData, highlight) : null;
  if (!lanes) document.getElementById("body-lanes")!.innerHTML = `<p class="empty pad">This bundle has no swimlane data (lanes.json).</p>`;
  let lanesLoaded = false;
  const drawer = new Drawer();
  const ev = assessDoc ? new Evidence(bundleUrl.replace(/\/$/, ""), assessDoc, auditDoc, drawer, {
    highlight: (rows) => highlight(rows),
    showInLanes: (attemptId, row) => { run("focusAttempt", { attemptId, row: row ?? null }); },
  }) : null;
  if (lanes) { lanes.ev = ev; lanes.base = bundleUrl; }
  if (ev) new MatrixPanel(document.getElementById("body-assessments")!, ev);
  else document.getElementById("body-assessments")!.innerHTML = `<p class="empty pad">This bundle has no assessments (assessments.json).</p>`;
  const claimsPanel = ev ? new ClaimsPanel(document.getElementById("body-claims")!, claimsDoc, ev) : null;
  if (!ev) document.getElementById("body-claims")!.innerHTML = `<p class="empty pad">This bundle has no claims.</p>`;
  const figures = viewsDoc?.views.length ? new FiguresPanel(document.getElementById("body-figures")!, coordinator, viewsDoc, claimsDoc) : null;
  if (!figures) {
    document.getElementById("body-figures")!.innerHTML = `<p class="empty pad">This bundle has no view specs (views.json).</p>`;
    describable("figures", { describe: () => ({ summary: "This bundle has no view specs.", data: { views: [] } }) });
  }
  if (!lanes) describable("lanes", { describe: () => ({ summary: "This bundle has no swimlane data.", data: { lanes: [] } }) });
  if (!ev) for (const key of ["assessments", "claims", "drawer"]) describable(key, { describe: () => ({ summary: "This bundle has no assessments.", data: null }) });

  const showTab = async (name: Tab) => {
    tab = name;
    host.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((b) => { const on = b.dataset.tab === name; b.setAttribute("aria-selected", String(on)); b.tabIndex = on ? 0 : -1; });
    host.querySelectorAll<HTMLElement>(".tab-body").forEach((d) => (d.hidden = d.id !== `body-${name}`));
    if (name === "figures") await figures?.render();
    if (name === "lanes" && lanes && !lanesLoaded) { lanesLoaded = true; await lanes.load(); }
    else if (name === "lanes" && lanes) lanes.render();
  };
  const layout = document.querySelector(".layout")!;
  const focusButton = host.querySelector<HTMLButtonElement>("[data-focus]")!;
  const setPanelFocus = (on: boolean) => {
    layout.classList.toggle("focus-panel", on);
    focusButton.textContent = on ? "Show cloud" : "Expand panel";
  };

  // ---- shell commands ----
  const obj = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: "object", required, properties, additionalProperties: false });
  register<{ tab: Tab }>({ name: "openTab", description: "Open a panel tab.", args: obj({ tab: { enum: [...TABS] } }),
    run: async ({ tab: t }) => { await showTab(t); return `Opened the ${tabLabels[t]} tab.`; } });
  register<{ on: boolean }>({ name: "setPanelFocus", description: "Reading mode: give the panel the window (on) or show the cloud (off).", args: obj({ on: { type: "boolean" } }),
    run: ({ on }) => { setPanelFocus(on); return on ? "Panel expanded." : "Cloud shown."; } });
  register<{ attemptId: string; row?: number | null }>({ name: "focusAttempt", description: "Show one attempt in the swimlanes, optionally selecting a unit (row id).",
    args: obj({ attemptId: { type: "string" }, row: { type: ["integer", "null"] } }, ["attemptId"]),
    run: async ({ attemptId, row }) => { if (!lanes) return "This bundle has no swimlanes."; await showTab("lanes"); await lanes.focusAttempt(attemptId, row ?? null); return `Swimlanes show attempt ${shortId(attemptId)}.`; } });
  register<{ id: string | null }>({ name: "focusClaim", description: "Open the claims tab on one claim; null clears the focus.", args: obj({ id: { type: ["string", "null"] } }),
    run: async ({ id }) => { await showTab("claims"); claimsPanel?.focus(id); return id ? `Claim ${id} in focus.` : "Cleared the claim focus."; } });
  register<{ id: string | null }>({ name: "focusView", description: "Open the figures tab on one view spec; null clears the focus.", args: obj({ id: { type: ["string", "null"] } }),
    run: async ({ id }) => { await showTab("figures"); await figures?.focus(id); return id ? `Figure ${id} in focus.` : "Cleared the figure focus."; } });
  provide({ key: "shell", get: () => ({ tab, focusPanel: layout.classList.contains("focus-panel") }),
    apply: async (st: { tab: Tab; focusPanel: boolean }) => { setPanelFocus(st.focusPanel); await showTab(st.tab); } });
  provide({ key: "claims", get: () => ({ focused: claimsPanel?.focused ?? null }), apply: (st: { focused: string | null }) => { claimsPanel?.focus(st.focused); } });
  provide({ key: "figures", get: () => ({ focused: figures?.focused ?? null }), apply: async (st: { focused: string | null }) => { await figures?.focus(st.focused); } });

  host.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((b) => {
    b.addEventListener("click", () => run("openTab", { tab: b.dataset.tab }));
    b.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      const i = TABS.indexOf(b.dataset.tab as Tab);
      const next = TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length];
      run("openTab", { tab: next }).then(() => host.querySelector<HTMLButtonElement>(`[data-tab="${next}"]`)!.focus());
    });
  });
  focusButton.addEventListener("click", () => run("setPanelFocus", { on: !layout.classList.contains("focus-panel") }));

  // ---- the cloud: Embedding Atlas registers its own tools (chart state: viewport, brush, legend; SQL; screenshots) ----
  type EaTool = { name: string; description: string; inputSchema: Record<string, unknown>; execute: (input: any, agent: unknown) => Promise<any> };
  // Cloud state can arrive (from a link or undo) before Embedding Atlas has published its embedding chart; it waits.
  let chartReady: () => void = () => undefined;
  let refreshing: Promise<void> = Promise.resolve();
  let committedCloud: Json | null = null;
  let pendingBefore: Record<string, Json> | null = null;
  let settle: ReturnType<typeof setTimeout> | undefined;
  let quietUntil = 0;
  // A pending gesture is recorded before any command starts, so the two never share one history entry.
  const flushGesture = () => {
    clearTimeout(settle);
    const b = pendingBefore;
    pendingBefore = null;
    if (b) recordChange("cloudChanged", "Changed the cloud view.", b);
  };
  onCommandBoundary(flushGesture);
  const chartReadyPromise = new Promise<void>((resolve) => { chartReady = resolve; });
  let eaTools: EaTool[] = [];
  let atlasState: Record<string, any> = {};
  const embeddingChartId = () => Object.entries(atlasState.charts ?? {}).find(([, spec]) => (spec as { type?: string }).type === "embedding")?.[0];
  const cloudState = () => { const id = embeddingChartId(); return id ? (atlasState.chartStates?.[id] ?? {}) : {}; };
  const signalChartReady = () => {
    if (cloudState().viewport && eaTools.some(tool => tool.name === "chart_set_state")) chartReady();
  };
  const panel = new ClusterArmPanel(document.getElementById("body-clusters")!, coordinator, highlight,
    lanes ? async (id, label) => { await showTab("lanes"); await lanes.focusCluster(id, label); } : undefined);
  const atlas = new EmbeddingAtlas(document.getElementById("atlas")!, {
    coordinator,
    // No `features` list: it pushed the per-column count charts below the fold and truncated long tags.
    data: { table: "units", id: "row_id", projection: { x: "x", y: "y" }, ...(neighborsColumn ? { neighbors: neighborsColumn } : {}), text: textColumn },
    colorScheme: dark() ? "dark" : "light",
    embeddingViewConfig: { autoLabelStopWords: STOP_WORDS },
    embeddingViewLabels: labels,
    defaultChartsConfig: {
      // shallow-merged over the default embedding spec, so data must be complete
      embedding: { data: { x: "x", y: "y", text: textColumn, ...(neighborsColumn ? { neighbors: neighborsColumn } : {}), category: colorBy === "none" ? null : colorBy } },
      include: ["condition", "task_id", "unit_kind", "tool_kind", "check_kind", "status", "harness_id", "trial_id", "cited_assessments", "cluster_label", textColumn],
    },
    onPredicateChange: (predicate) => { refreshing = Promise.all([panel.setPredicate(predicate), lanes?.setPredicate(predicate)]).then(() => undefined); },
    onStateChange: (state) => {
      const before = { ...getState(), cloud: committedCloud };
      atlasState = state as Record<string, any>;
      signalChartReady();
      // A pan, brush or legend click in the embedding view itself: one history entry once the gesture settles.
      // The first viewport Embedding Atlas publishes is its initial layout, not a reader's change.
      const committed = committedCloud as { viewport?: unknown } | null;
      if (!committed?.viewport) { committedCloud = getState().cloud ?? null; return; }
      // Embedding Atlas reports changes asynchronously: what arrives during or just after a command or a restored
      // state belongs to it, not to the reader.
      if (commandRunning() || Date.now() < quietUntil) { committedCloud = getState().cloud ?? null; return; }
      {
        pendingBefore ??= before;
        clearTimeout(settle);
        settle = setTimeout(async () => { await refreshing; flushGesture(); }, 400);
      }
    },
    modelContext: { provideContext: (context: { tools?: EaTool[] }) => { eaTools = context.tools ?? []; signalChartReady(); } },
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => atlas.update({ colorScheme: dark() ? "dark" : "light" }));
  const eaTool = async (name: string, input: Record<string, unknown> = {}) => {
    const tool = eaTools.find((t) => t.name === name);
    if (!tool) throw new Error(`Embedding Atlas tool ${name} is not available.`);
    return tool.execute(input, null);
  };
  const setCloudState = async (patch: Record<string, unknown>) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([chartReadyPromise, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("The embedding chart is not ready.")), 10_000); })]);
    } finally { clearTimeout(timeout); }
    const id = embeddingChartId();
    if (!id) throw new Error("The embedding chart is not ready.");
    const next = Object.fromEntries(Object.entries({ ...cloudState(), ...patch }).filter(([, v]) => v !== null && v !== undefined));
    await eaTool("chart_set_state", { id, state: next });
    await new Promise((r) => setTimeout(r, 50));   // let Embedding Atlas publish the predicate, then wait for the panels
    await refreshing;
  };
  const point = obj({ x: { type: "number" }, y: { type: "number" } });
  register<{ x: number; y: number; scale: number }>({ name: "setViewport", description: "Pan and zoom the cloud: center (x, y) in data units and scale (data units to [-1, 1]).",
    args: obj({ x: { type: "number" }, y: { type: "number" }, scale: { type: "number", exclusiveMinimum: 0 } }),
    run: async ({ x, y, scale }) => { await setCloudState({ viewport: { x, y, scale } }); return `Cloud viewport at (${x.toFixed(2)}, ${y.toFixed(2)}), scale ${scale.toFixed(2)}.`; } });
  register<{ rectangle?: { xMin: number; yMin: number; xMax: number; yMax: number }; polygon?: { x: number; y: number }[] }>({ name: "selectRange",
    description: "Brush the cloud with a rectangle or a lasso polygon in data units. Clusters × arm counts only the brushed units and the swimlanes dim units outside it; assessments, claims and figures keep counting every attempt.",
    args: { type: "object", properties: { rectangle: obj({ xMin: { type: "number" }, yMin: { type: "number" }, xMax: { type: "number" }, yMax: { type: "number" } }), polygon: { type: "array", minItems: 3, items: point } }, additionalProperties: false },
    run: async ({ rectangle, polygon }) => { await setCloudState({ brush: rectangle ?? polygon ?? null }); return rectangle ? "Brushed a rectangle in the cloud." : "Brushed a lasso in the cloud."; } });
  register({ name: "clearSelection", description: "Clear the cloud brush and highlight.", args: obj({}),
    run: async () => { await setCloudState({ brush: null }); highlight(null); return "Cleared the cloud selection."; } });
  register<{ categories: string[] }>({ name: "setLegendSelection",
    description: `Select color-legend categories in the cloud (empty clears). The legend shows the ${LEGEND_LIMIT} most frequent values and folds the rest into "(other N)"; a folded value is refused, and its column's count plot selects it (cloudTool chart_set_state).`,
    args: obj({ categories: { type: "array", items: { type: "string" } } }),
    run: async ({ categories }) => {
      const id = embeddingChartId();
      const column = (id ? (atlasState.charts?.[id] as { data?: { category?: string | null } } | undefined)?.data?.category : undefined) ?? (colorBy === "none" ? null : colorBy);
      if (categories.length && !column) throw new Error("The cloud is not coloured by a column, so its legend has no categories to select.");
      if (categories.length && column) {
        const quoted = `"${column.replaceAll('"', '""')}"`;
        const counts = rowsOf(await coordinator.query(`SELECT CAST(${quoted} AS TEXT) AS value, count(*)::INTEGER AS count FROM units WHERE ${quoted} IS NOT NULL GROUP BY 1`))
          .map((r) => ({ value: String(r.value), count: Number(r.count) }));
        const { folded, unknown } = unselectableLegendCategories(categories, counts);
        if (unknown.length) throw new Error(`No unit has ${column} ${unknown.map((c) => JSON.stringify(c)).join(", ")}.`);
        if (folded.length) throw new Error(`The colour legend shows the ${LEGEND_LIMIT} most frequent ${column} values and folds the rest into "(other N)", so it cannot select ${folded.map((c) => JSON.stringify(c)).join(", ")}. Select ${folded.length > 1 ? "them" : "it"} in the ${column} count plot (cloudTool chart_set_state on that chart).`);
      }
      await setCloudState({ legend: categories.length ? { selection: categories } : null });
      return categories.length ? `Legend selection: ${categories.join(", ")}.` : "Cleared the legend selection.";
    } });
  register<{ tool: string; input?: Record<string, unknown> }>({ name: "cloudTool", description: "Run one of Embedding Atlas's own tools (see listCloudTools), e.g. chart_set_state or data_query.",
    args: obj({ tool: { type: "string" }, input: { type: "object" } }, ["tool"]),
    run: async ({ tool, input }) => {
      const result = await eaTool(tool, input ?? {});
      await new Promise((r) => setTimeout(r, 50));   // a tool that changes the predicate settles like the named cloud commands
      await refreshing;
      lastCloudResult = result;
      // The result travels with the command's reply; a long one is cut here and stays whole in window.ebo.cloudResult().
      const json = result === undefined ? "" : JSON.stringify(result) ?? "";
      const shown = json.length > CLOUD_RESULT_CHARS ? `${json.slice(0, CLOUD_RESULT_CHARS)}… (${json.length.toLocaleString()} characters; the whole result is in window.ebo.cloudResult())` : json;
      return `Ran Embedding Atlas tool ${tool}.${shown ? ` Result: ${shown}` : ""}`;
    } });
  let lastCloudResult: unknown = null;
  const CLOUD_RESULT_CHARS = 20_000;
  provide({ key: "highlight", get: () => ({ rows: highlighted }), apply: (st: { rows: number[] | null }) => { highlight(st.rows); } });
  provide({ key: "cloud", get: () => {
      const st = cloudState();
      return { viewport: st.viewport ?? null, brush: st.brush ?? null, legend: st.legend?.selection ?? null } as Json;
    },
    apply: async (st: { viewport: unknown; brush: unknown; legend: string[] | null }) => {
      await setCloudState({ viewport: st.viewport, brush: st.brush, legend: st.legend?.length ? { selection: st.legend } : null });
    } });

  register<{ fraction: number }>({ name: "setSplit", description: "Share of the window height given to the cloud (0.25-0.85).", args: obj({ fraction: { type: "number", minimum: 0.25, maximum: 0.85 } }),
    run: ({ fraction }) => { setSplit(fraction); return `Cloud takes ${Math.round(fraction * 100)}% of the height.`; } });
  await panel.setPredicate(null);
  await showTab(initialPanel === "lanes" && !lanes ? "clusters" : initialPanel);
  setupSplitter();

  // ---- URL: the state serializes to the fragment ----
  // Fragment grammar shared with packet pages: #claim=C3 · #assessment=<assertion id> · #record=<attempt id>:<row id>
  // · #audit=<attempt id> · #chains=<attempt id> · #attempt=<attempt id> · #view=<view id> · #state=<encoded state>.
  const legacy = (event: CommandEvent): string | null => {
    const a = event.args as Record<string, any>;
    switch (event.command) {
      case "openAssessment": return `assessment=${a.id}`;
      case "openUnit": return `record=${a.attemptId}:${a.row}`;
      case "openAudit": return `audit=${a.attemptId}`;
      case "openChains": return `chains=${a.attemptId}`;
      case "focusAttempt": return a.row == null ? `attempt=${a.attemptId}` : `record=${a.attemptId}:${a.row}`;
      case "focusClaim": return a.id ? `claim=${a.id}` : null;
      case "focusView": return a.id ? `view=${a.id}` : null;
      default: return null;
    }
  };
  let writing = false;
  subscribe((event) => { committedCloud = (event.state as Record<string, Json>).cloud ?? null; if (event.command !== "cloudChanged") quietUntil = Date.now() + 500; });
  committedCloud = getState().cloud ?? null;
  subscribe((event) => {
    if (event.source === "url") return;
    const fragment = legacy(event) ?? `state=${encodeState(getState())}`;
    writing = true;
    try { history.replaceState(null, "", `${location.pathname}${location.search}#${fragment}`); } catch { /* ignore */ }
    writing = false;
  });
  const applyFragment = async () => {
    if (writing) return;
    const m = location.hash.match(/^#(claim|assessment|record|audit|chains|attempt|view|state)=(.+)$/);
    if (!m) return;
    const [, kind, raw] = m, val = decodeURIComponent(raw);
    if (kind === "state") { await setState(decodeState(val), "url"); return; }
    if (kind === "view") { await run("focusView", { id: val }, "url"); return; }
    if (kind === "claim") { await run("focusClaim", { id: val }, "url"); return; }
    if (!ev) return;
    if (kind === "assessment") { await run("openTab", { tab: "assessments" }, "url"); await run("openAssessment", { id: val }, "url"); }
    else if (kind === "audit") await run("openAudit", { attemptId: val }, "url");
    else if (kind === "chains") { await run("focusAttempt", { attemptId: val, row: null }, "url"); await run("openChains", { attemptId: val }, "url"); }
    else if (kind === "attempt") await run("focusAttempt", { attemptId: val, row: null }, "url");
    else if (kind === "record") {
      const i = val.lastIndexOf(":"), attemptId = val.slice(0, i), row = Number(val.slice(i + 1));
      await run("focusAttempt", { attemptId, row }, "url"); await run("openUnit", { attemptId, row }, "url");
    }
  };
  await applyFragment();
  addEventListener("hashchange", () => { applyFragment(); });

  // ---- the programmatic surface: tests and a later Agent Mode use the same commands as the controls ----
  (window as any).ebo = {
    run: (name: string, args?: Record<string, unknown>) => run(name, args ?? {}, "assistant"),
    commands: listCommands,
    getState, setState: (state: Record<string, Json>) => setState(state, "assistant"),
    encodeState, decodeState, describe, subscribe,
    listCloudTools: () => eaTools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    cloudResult: () => lastCloudResult,
    drawerViews: (): DrawerView[] => drawer.views,
    ready: true,
  };
  document.body.dataset.eboReady = "1";
}

/** Layout preference (kept in local storage, not in the shared state). */
function setSplit(frac: number) {
  const layout = document.querySelector(".layout") as HTMLElement;
  const f = Math.min(0.85, Math.max(0.25, frac));
  layout.style.setProperty("--atlas-frac", String(f));
  try { localStorage.setItem("ebo-atlas-split", String(f)); } catch { /* storage unavailable */ }
}

function setupSplitter() {
  const layout = document.querySelector(".layout") as HTMLElement;
  const splitter = document.getElementById("splitter")!;
  splitter.setAttribute("data-ebo-target", "setSplit");
  splitter.setAttribute("data-ebo-command", "setSplit");
  const set = (frac: number) => run("setSplit", { fraction: Math.min(0.85, Math.max(0.25, frac)) });
  try { const s = localStorage.getItem("ebo-atlas-split"); if (s) setSplit(Number(s)); } catch { /* ignore */ }
  splitter.addEventListener("pointerdown", (e) => {
    splitter.setPointerCapture(e.pointerId);
    const rect = layout.getBoundingClientRect();
    const move = (ev: PointerEvent) => set((ev.clientY - rect.top) / rect.height);
    const up = () => { splitter.removeEventListener("pointermove", move); splitter.removeEventListener("pointerup", up); };
    splitter.addEventListener("pointermove", move);
    splitter.addEventListener("pointerup", up);
  });
  splitter.addEventListener("keydown", (e) => {
    const cur = Number(getComputedStyle(layout).getPropertyValue("--atlas-frac")) || 0.5;
    if (e.key === "ArrowUp") set(cur - 0.05);
    if (e.key === "ArrowDown") set(cur + 0.05);
  });
}

main().catch((e) => {
  console.error(e);
  status(`Failed to load: ${e?.message ?? e}`, true);
});

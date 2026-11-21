/**
 * Build-time clusters for a large cloud, so the viewer only loads the table. Per unit family (messages, episodes,
 * tools) the layout's positions are rescaled side by side as the viewer places them; units are binned on a 256 × 256
 * grid, the counts smoothed by two box blurs, and the connected regions of dense cells become clusters. Each cluster
 * is labelled by the facets most over-represented in it: a tool's command head, check kind, target class, failure and
 * occurrences; a message's words. This is the viewer's own method (viewer/src/layout.ts) with connected dense regions
 * in place of Embedding Atlas's cluster finder. Numbers are exploratory.
 */
export type ClusterInput = { family: string; unit_kind: string; text: string; tool_kind: string | null; command_head: string | null; check_kind: string | null;
  target: string | null; status: string | null; occurrences: readonly string[] };
export type CloudLabel = { x: number; y: number; text: string; level: number; priority: number };

const FAMILIES = ["messages", "episodes", "tools"] as const;
const GRID = 256;
// Words that say nothing about what a unit is about; the viewer's list is longer, this keeps the common ones.
const STOP = new Set(`the a an and or of to in on for with this that it is are be as at by from not now so then let me i'll i'm we you they them its it's will can should would could all any each more also just into out up there here what which when while about after before over under than these those have has had was were been being do does did done use using file files make sure need want check run see let's going one two first next`.split(/\s+/u));

function targetClass(t: string | null) {
  if (!t) return null;
  const parts = t.split("/"), name = parts.at(-1)!;
  const ext = name.includes(".") && !name.startsWith(".") ? `*.${name.split(".").at(-1)!}` : name;
  return parts.length > 1 ? [...parts.slice(0, -1).slice(-2), ext].join("/") : ext;
}

export function facets(u: ClusterInput): string[] {
  if (u.unit_kind === "tool") {
    const f = [u.command_head ? `\`${u.command_head}\`` : u.tool_kind];
    if (u.check_kind && !["other", "inspect"].includes(u.check_kind)) f.push(u.check_kind);
    if ((u.tool_kind === "read" || u.tool_kind === "edit") && u.target) f.push(targetClass(u.target));
    if (u.status === "error") f.push("failed");
    f.push(...u.occurrences);
    return f.filter((x): x is string => Boolean(x));
  }
  return [...new Set((u.text.toLowerCase().match(/[a-z][a-z0-9_-]{3,}/gu) ?? []).filter((w) => !STOP.has(w)))];
}

function blur(map: Float32Array): Float32Array {
  let current = map;
  for (let pass = 0; pass < 2; pass++) {
    const next = new Float32Array(GRID * GRID), r = 3;
    for (let y = 0; y < GRID; y++) for (let x = 0; x < GRID; x++) {
      let s = 0, n = 0;
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx >= 0 && yy >= 0 && xx < GRID && yy < GRID) { s += current[yy * GRID + xx]!; n++; }
      }
      next[y * GRID + x] = s / n;
    }
    current = next;
  }
  return current;
}

/** Every row's facets as codes: row i's are `ids[offsets[i]..offsets[i + 1]]`, each an index into `names`. */
export class FacetIndex {
  readonly names: string[] = [];
  private readonly codes = new Map<string, number>();
  private ids: number[] = [];
  private readonly offsets: number[] = [0];
  add(unit: ClusterInput): void {
    for (const facet of new Set(facets(unit))) {
      let code = this.codes.get(facet);
      if (code === undefined) { code = this.names.length; this.codes.set(facet, code); this.names.push(facet); }
      this.ids.push(code);
    }
    this.offsets.push(this.ids.length);
  }
  of(row: number): number[] { return this.ids.slice(this.offsets[row]!, this.offsets[row + 1]!); }
}

/**
 * Places each family side by side (rewriting `xy` in place), assigns clusters and labels from each row's facet codes,
 * so millions of units are never held as objects.
 */
export function clusterCloud(xy: Float32Array, familyOf: readonly string[], index: FacetIndex):
  { clusterId: Int32Array; clusterOf: (id: number) => string | null; labels: CloudLabel[] } {
  const n = familyOf.length, clusterId = new Int32Array(n).fill(-1), names = new Map<number, string>(), labels: CloudLabel[] = [];
  let offset = 0;
  for (const [fi, family] of FAMILIES.entries()) {
    const members: number[] = [];
    for (let i = 0; i < n; i++) if (familyOf[i] === family) members.push(i);
    if (!members.length) continue;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const row of members) { minX = Math.min(minX, xy[2 * row]!); maxX = Math.max(maxX, xy[2 * row]!); minY = Math.min(minY, xy[2 * row + 1]!); maxY = Math.max(maxY, xy[2 * row + 1]!); }
    for (const row of members) { xy[2 * row] = xy[2 * row]! - minX + offset; xy[2 * row + 1] = xy[2 * row + 1]! - minY; }
    const box = { x0: offset, w: Math.max(1e-6, maxX - minX), h: Math.max(1e-6, maxY - minY) };
    offset += box.w * 1.12 + 1;
    const cell = (row: number) => Math.min(GRID - 1, Math.floor(((xy[2 * row + 1]!) / box.h) * GRID)) * GRID + Math.min(GRID - 1, Math.floor(((xy[2 * row]! - box.x0) / box.w) * GRID));
    const counts = new Float32Array(GRID * GRID);
    for (const row of members) counts[cell(row)]! += 1;
    const density = blur(counts);
    // Dense cells: above twice the median of the occupied cells. Connected dense regions (8-neighbourhood) are clusters.
    const occupied = [...density].filter((d) => d > 0).sort((a, b) => a - b);
    const threshold = 2 * (occupied[occupied.length >> 1] ?? 0);
    const region = new Int32Array(GRID * GRID).fill(-1), sums: number[] = [], sizes: number[] = [];
    for (let start = 0; start < GRID * GRID; start++) {
      if (region[start] !== -1 || density[start]! <= threshold) continue;
      const id = sums.length, stack = [start];
      region[start] = id; sums.push(0); sizes.push(0);
      while (stack.length) {
        const at = stack.pop()!, x = at % GRID, y = Math.floor(at / GRID);
        sums[id]! += density[at]!; sizes[id]! += 1;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy, next = yy * GRID + xx;
          if (xx >= 0 && yy >= 0 && xx < GRID && yy < GRID && region[next] === -1 && density[next]! > threshold) { region[next] = id; stack.push(next); }
        }
      }
    }
    const inside = new Map<number, number[]>();
    // A unit in a cell under the threshold, within the blur radius of a region, joins the densest such region.
    const regionAt = (at: number) => {
      if (region[at]! >= 0) return region[at]!;
      const x = at % GRID, y = Math.floor(at / GRID);
      let best = -1, bestDensity = -1;
      for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
        const xx = x + dx, yy = y + dy, next = yy * GRID + xx;
        if (xx >= 0 && yy >= 0 && xx < GRID && yy < GRID && region[next]! >= 0 && density[next]! > bestDensity) { best = region[next]!; bestDensity = density[next]!; }
      }
      return best;
    };
    for (const row of members) {
      const r = regionAt(cell(row));
      if (r >= 0 && sizes[r]! >= 4) (inside.get(r) ?? inside.set(r, []).get(r)!).push(row);
    }
    const background = new Map<number, number>();
    for (const row of members) for (const f of index.of(row)) background.set(f, (background.get(f) ?? 0) + 1);
    [...inside].filter(([, rows]) => rows.length >= 5).sort(([a], [b]) => sums[b]! - sums[a]!).forEach(([, rows], ci) => {
      const id = 1000 * (fi + 1) + ci, counted = new Map<number, number>();
      for (const row of rows) for (const f of index.of(row)) counted.set(f, (counted.get(f) ?? 0) + 1);
      const top = [...counted].filter(([, k]) => k / rows.length >= 0.25)
        .map(([f, k]) => [f, (k / rows.length) * Math.log((k / rows.length) / ((background.get(f) ?? 1) / members.length) + 1e-9)] as const)
        .sort((a, b) => b[1] - a[1]).slice(0, 3).map(([f]) => index.names[f]!);
      const text = top.join(" · ") || family;
      names.set(id, text);
      for (const row of rows) clusterId[row] = id;
      const xs = rows.map((row) => xy[2 * row]!).sort((a, b) => a - b), ys = rows.map((row) => xy[2 * row + 1]!).sort((a, b) => a - b);
      labels.push({ x: xs[xs.length >> 1]!, y: ys[ys.length >> 1]!, text, level: 0, priority: rows.length });
    });
    labels.push({ x: box.x0 + box.w / 2, y: box.h + 0.5, text: family.toUpperCase(), level: 0, priority: 1e9 });
  }
  return { clusterId, clusterOf: (id) => names.get(id) ?? null, labels };
}

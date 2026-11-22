/**
 * Which requested legend categories the cloud's colour legend cannot select. Embedding Atlas 0.26 shows the ten most
 * frequent values of the colour column and folds the rest into one "(other N)" item; a legend selection names items,
 * so a folded value selects nothing. Values tied with the tenth are treated as shown, since the legend's order among
 * ties is not fixed.
 */
export const LEGEND_LIMIT = 10;

export type LegendCount = { value: string; count: number };

export function unselectableLegendCategories(requested: readonly string[], counts: readonly LegendCount[], limit = LEGEND_LIMIT):
  { folded: string[]; unknown: string[] } {
  const sorted = [...counts].sort((a, b) => b.count - a.count);
  const known = new Map(sorted.map(({ value, count }) => [value, count]));
  const cutoff = sorted.length > limit ? sorted[limit - 1]!.count : -Infinity;
  const folded: string[] = [], unknown: string[] = [];
  for (const category of requested) {
    if (/^\((?:other [^)]*|null)\)$/u.test(category)) continue;   // the legend's own "(other N)" and "(null)" items
    const count = known.get(category);
    if (count === undefined) unknown.push(category);
    else if (count < cutoff) folded.push(category);
  }
  return { folded, unknown };
}

import type { UniformEvent } from "./uniform-events.js";

/** Source-local precedence. A timestamp or a display tie-break never proves execution order. */
export function nativeEventPrecedence(left: UniformEvent, right: UniformEvent): number | undefined {
  if (left.runId !== right.runId || left.attemptId !== right.attemptId) return undefined;
  if (left.id === right.id) return 0;
  if (left.nativeOrder.status !== "known" || right.nativeOrder.status !== "known"
      || left.nativeOrder.domain !== right.nativeOrder.domain) return undefined;
  return Math.sign(left.nativeOrder.value - right.nativeOrder.value) || undefined;
}

/** Stable presentation order. Callers must use nativeEventPrecedence for before/after claims. */
export function compareEventDisplayOrder(left: UniformEvent, right: UniformEvent): number {
  const key = (event: UniformEvent): readonly [string, string, number, string, number, string] => [
    event.runId, event.attemptId,
    event.nativeTime.status === "known" && Number.isFinite(Date.parse(event.nativeTime.value))
      ? Date.parse(event.nativeTime.value) : Number.POSITIVE_INFINITY,
    event.nativeOrder.status === "known" ? event.nativeOrder.domain : "",
    event.nativeOrder.status === "known" ? event.nativeOrder.value : Number.POSITIVE_INFINITY,
    event.id,
  ];
  const a = key(left), b = key(right);
  for (let index = 0; index < a.length; index += 1) {
    const x = a[index]!, y = b[index]!;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** Explicit common inference identity; execution order within a predeclared batch is not feedback. */
export function sameInference(left: UniformEvent, right: UniformEvent): boolean {
  if (left.runId !== right.runId || left.attemptId !== right.attemptId) return false;
  for (const key of ["inferenceId", "modelRequestId", "responseId"] as const) {
    const value = left.attributes[key];
    if (typeof value === "string" && value !== "" && value === right.attributes[key]) return true;
  }
  return false;
}

/** Merge source streams for grouping without allowing clocks to reverse a stream's native ordinals.
 * Cross-domain placement remains presentation order and supplies no precedence by itself.
 */
export function mergeNativeEventStreams(events: readonly UniformEvent[]): UniformEvent[] {
  const groups = new Map<string, UniformEvent[]>();
  for (const event of events) {
    const key = JSON.stringify([event.runId, event.attemptId, event.nativeOrder.status === "known"
      ? ["known", event.nativeOrder.domain] : ["unknown", event.id]]);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [event]); else group.push(event);
  }
  type Stream = { events: UniformEvent[]; index: number };
  const heap: Stream[] = [];
  const compare = (a: Stream, b: Stream) => compareEventDisplayOrder(a.events[a.index]!, b.events[b.index]!);
  const push = (stream: Stream) => {
    heap.push(stream);
    let index = heap.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (compare(heap[parent]!, heap[index]!) <= 0) break;
      [heap[parent], heap[index]] = [heap[index]!, heap[parent]!]; index = parent;
    }
  };
  for (const group of groups.values()) push({ events: group.sort((a, b) => nativeEventPrecedence(a, b) ?? compareEventDisplayOrder(a, b)), index: 0 });
  const result: UniformEvent[] = [];
  while (heap.length) {
    const first = heap[0]!, last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let index = 0;
      while (true) {
        const left = index * 2 + 1, right = left + 1;
        const child = right < heap.length && compare(heap[right]!, heap[left]!) < 0 ? right : left;
        if (child >= heap.length || compare(heap[index]!, heap[child]!) <= 0) break;
        [heap[index], heap[child]] = [heap[child]!, heap[index]!]; index = child;
      }
    }
    result.push(first.events[first.index]!);
    first.index += 1;
    if (first.index < first.events.length) push(first);
  }
  return result;
}

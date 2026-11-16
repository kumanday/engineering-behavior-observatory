/** Independent fixture audit of declared ATIF fields. Not an import-admission adapter. */
export function summarizeAtifFixture(document) {
  const calls = [], results = [], agentSteps = [];
  let compactions = 0, delegations = 0, summarizers = 0, gap = false;
  const visit = (trajectory, pointer = "#", contextOnly = false) => {
    if (trajectory.extra?.partial) gap = true;
    const childRoles = new Map();
    for (const step of trajectory.steps ?? []) {
      const conversionGap = step.extra?.added_by === "hlb";
      const compaction = step.extra?.context_management?.type === "compaction" || step.extra?.pi_event_type === "compaction";
      for (const result of step.observation?.results ?? []) for (const reference of result.subagent_trajectory_ref ?? []) {
        if (!reference.trajectory_id) continue;
        const role = contextOnly || step.is_copied_context || conversionGap ? "borrowed" : compaction ? "summary" : "delegated";
        const roles = childRoles.get(reference.trajectory_id) ?? new Set();
        roles.add(role); childRoles.set(reference.trajectory_id, roles);
      }
      if (step.is_copied_context) continue;
      if (conversionGap || trajectory.extra?.partial) gap = true;
      if (conversionGap) continue;
      if (compaction) compactions += 1;
      if (step.source === "agent" && !contextOnly) agentSteps.push(step);
      for (const call of step.tool_calls ?? []) if (!contextOnly) calls.push({ ...call, trajectory: pointer });
      for (const result of step.observation?.results ?? []) {
        if (!contextOnly) results.push({ ...result, trajectory: pointer });
        for (const reference of result.subagent_trajectory_ref ?? []) {
          if (compaction) summarizers += 1;
          else if (!contextOnly) delegations += 1;
        }
      }
    }
    (trajectory.subagent_trajectories ?? []).forEach((child, index) => {
      const roles = childRoles.get(child.trajectory_id);
      if (roles === undefined || roles.has("delegated") && roles.has("summary")) gap = true;
      visit(child, `${pointer}/subagent_trajectories/${index}`, contextOnly || roles === undefined || !roles.has("delegated") || roles.has("summary"));
    });
  };
  visit(document);
  const linked = results.filter((result) => result.source_call_id && calls.some((call) => call.trajectory === result.trajectory && call.tool_call_id === result.source_call_id));
  const inferenceTracked = !gap && agentSteps.length > 0 && agentSteps.every((step) => Number.isSafeInteger(step.llm_call_count) && step.llm_call_count >= 0);
  const summary = { recordedCalls: calls.length, recordedNewCalls: calls.length, recordedCallsIncludingChildren: calls.length,
    linkedResults: linked.length, declaredInferenceCount: inferenceTracked ? agentSteps.reduce((sum, step) => sum + step.llm_call_count, 0) : null,
    fullAttemptToolCount: null, complete: false, terminalState: null, compactions, effectiveContextAvailable: false, delegations, summarizers };
  return { summary, calls, results: linked, agentSteps, gap };
}

/** Operator-bound fixture sequence; references never trigger filesystem or network access. */
export function summarizeFixtureSequence(segments, first) {
  const byPath = new Map(segments.map((segment) => [segment.path, segment.document]));
  const visited = new Set(), signatures = [], limitations = [];
  let path = first, run;
  while (path) {
    if (visited.has(path)) { limitations.push("CONTINUATION_CYCLE"); break; }
    const document = byPath.get(path);
    if (!document) { limitations.push("CONTINUATION_REFERENCE_UNAVAILABLE"); break; }
    if (run !== undefined && document.session_id !== run) { limitations.push("CONTINUATION_RUN_ID_MISMATCH"); break; }
    run = document.session_id; visited.add(path);
    const audited = piFixtureSourceMeasures(document);
    signatures.push(...audited.signatures.map((signature) => ({ ...signature, document: path })));
    const next = document.continued_trajectory_ref;
    if (next && (next.includes("..") || next.includes(":") || next.startsWith("/") || next.includes("\\"))) {
      limitations.push("UNSAFE_CONTINUATION_REFERENCE"); break;
    }
    path = next;
  }
  return { retainedSegments: visited.size, recordedNewCalls: signatures.length, signatures, limitations, fullAttemptToolCount: null };
}

export function piFixtureSourceMeasures(document) {
  const audit = summarizeAtifFixture(document);
  const missing = (reason) => ({ status: "unavailable", reason });
  const known = (value, unit) => ({ status: "known", value, unit });
  const sum = (field, extra = false) => {
    if (audit.gap || audit.agentSteps.length === 0) return undefined;
    const values = audit.agentSteps.map((step) => extra ? step.metrics?.extra?.[field] : step.metrics?.[field]);
    return values.every((value) => Number.isSafeInteger(value) && value >= 0) ? values.reduce((a, b) => a + b, 0) : undefined;
  };
  const prompt = sum("prompt_tokens"), cached = sum("cached_tokens"), writes = sum("cache_write_tokens", true), output = sum("completion_tokens");
  const usage = (value, finalField) => value === undefined ? missing("STEP_USAGE_INCOMPLETE")
    : document.final_metrics?.[finalField] !== undefined && document.final_metrics[finalField] !== value
      ? missing("STEP_FINAL_USAGE_CONFLICT") : known(value, "tokens");
  const signatures = audit.calls.map((call) => {
    const statuses = audit.results.filter((result) => result.trajectory === call.trajectory && result.source_call_id === call.tool_call_id)
      .map((result) => result.extra?.is_error);
    return { id: call.trajectory === "#" ? call.tool_call_id : `${call.trajectory}:${call.tool_call_id}`, name: call.function_name,
      failed: statuses.length > 0 && statuses.every((value) => typeof value === "boolean") ? statuses.some(Boolean) : null };
  }).sort((a, b) => a.id.localeCompare(b.id));
  const input = prompt === undefined || cached === undefined || writes === undefined ? missing("STEP_USAGE_INCOMPLETE")
    : cached + writes > prompt ? missing("PI_INCLUSIVE_PROMPT_CONFLICT")
      : document.final_metrics?.extra?.cache_write_tokens !== undefined && document.final_metrics.extra.cache_write_tokens !== writes
        ? missing("STEP_FINAL_USAGE_CONFLICT")
      : usage(prompt, "total_prompt_tokens").status === "unavailable" || usage(cached, "total_cached_tokens").status === "unavailable"
        ? missing("STEP_FINAL_USAGE_CONFLICT") : known(prompt - cached - writes, "tokens");
  const measures = {
    "tool-operation-count": audit.gap ? missing("PRODUCER_PARTIAL_HISTORY") : known(audit.calls.length, "identified-logical-tool-operations"),
    "tool-error-count": audit.gap ? missing("PRODUCER_PARTIAL_HISTORY") : signatures.some(({ failed }) => failed === null)
      ? missing("TOOL_RESULT_STATUS_INCOMPLETE") : known(signatures.filter(({ failed }) => failed).length, "logical-tool-operations"),
    "input-token-count": input,
    "output-token-count": usage(output, "total_completion_tokens"),
    "cache-read-input-token-count": usage(cached, "total_cached_tokens"),
  };
  return { ...audit, signatures, measures };
}

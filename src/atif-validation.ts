/** EBO's structural contract for standard ATIF fields. Extensions are retained data. */
export function validateAtifStructure(document: Record<string, unknown>): { code: string; pointer: string }[] {
  const diagnostics: { code: string; pointer: string }[] = [];
  const issue = (pointer: string, code = "ATIF_FIELD_TYPE") => { if (diagnostics.length < 100) diagnostics.push({ code, pointer }); };
  const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
  const optional = (o: Record<string, unknown>, key: string, pointer: string, check: (v: unknown) => boolean) => {
    if (o[key] !== undefined && o[key] !== null && !check(o[key])) issue(`${pointer}/${key}`);
  };
  const string = (v: unknown) => typeof v === "string";
  const integer = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0;
  const content = (v: unknown): boolean => typeof v === "string" || Array.isArray(v) && v.every((part) => {
    if (!record(part) || typeof part.type !== "string") return false;
    if (part.type === "text") return typeof part.text === "string";
    if (part.type === "image" || part.type === "audio") return record(part.source) && typeof part.source.path === "string";
    // Future content parts remain retained, without pretending to render them.
    return true;
  });
  const metrics = (v: unknown, pointer: string) => {
    if (!record(v)) { issue(pointer); return; }
    for (const [key, value] of Object.entries(v)) {
      if (key === "extra" || value === null) continue;
      if (/(?:tokens|cost|count|seconds|duration|steps)$/u.test(key) && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) issue(`${pointer}/${key}`);
      if (["prompt_token_ids", "completion_token_ids", "logprobs"].includes(key)
          && (!Array.isArray(value) || value.some((x) => typeof x !== "number" || !Number.isFinite(x)))) issue(`${pointer}/${key}`);
    }
  };
  const visit = (trajectory: Record<string, unknown>, pointer: string) => {
    if (typeof trajectory.schema_version !== "string") issue(`${pointer}/schema_version`, "ATIF_SCHEMA_VERSION_REQUIRED");
    if (!record(trajectory.agent) || typeof trajectory.agent.name !== "string") issue(`${pointer}/agent`, "ATIF_AGENT_REQUIRED");
    else {
      optional(trajectory.agent, "version", `${pointer}/agent`, string);
      optional(trajectory.agent, "model_name", `${pointer}/agent`, string);
      optional(trajectory.agent, "tool_definitions", `${pointer}/agent`, Array.isArray);
    }
    optional(trajectory, "session_id", pointer, string);
    optional(trajectory, "trajectory_id", pointer, string);
    optional(trajectory, "continued_trajectory_ref", pointer, string);
    if (trajectory.final_metrics != null) metrics(trajectory.final_metrics, `${pointer}/final_metrics`);
    if (!Array.isArray(trajectory.steps) || trajectory.steps.length === 0) { issue(`${pointer}/steps`, "ATIF_STEPS_REQUIRED"); return; }
    const ids = new Set<number>();
    for (const [index, step] of trajectory.steps.entries()) {
      const sp = `${pointer}/steps/${index}`;
      if (!record(step)) { issue(sp); continue; }
      if (!Number.isSafeInteger(step.step_id) || Number(step.step_id) < 1 || ids.has(Number(step.step_id))) issue(`${sp}/step_id`, "ATIF_STEP_ID_INVALID");
      ids.add(Number(step.step_id));
      if (!["agent", "system", "user"].includes(String(step.source))) issue(`${sp}/source`, "ATIF_STEP_SOURCE_INVALID");
      optional(step, "message", sp, content);
      optional(step, "reasoning_content", sp, string);
      optional(step, "timestamp", sp, string);
      optional(step, "llm_call_count", sp, integer);
      optional(step, "is_copied_context", sp, (x) => typeof x === "boolean");
      if (step.metrics != null) metrics(step.metrics, `${sp}/metrics`);
      if (step.tool_calls != null) {
        if (!Array.isArray(step.tool_calls)) issue(`${sp}/tool_calls`);
        else for (const [ci, call] of step.tool_calls.entries()) {
          const cp = `${sp}/tool_calls/${ci}`;
          if (!record(call)) { issue(cp); continue; }
          if (typeof call.tool_call_id !== "string" || !call.tool_call_id.length) issue(`${cp}/tool_call_id`);
          if (typeof call.function_name !== "string") issue(`${cp}/function_name`);
          optional(call, "arguments", cp, record);
        }
      }
      if (step.observation != null) {
        if (!record(step.observation) || !Array.isArray(step.observation.results)) issue(`${sp}/observation`);
        else for (const [ri, result] of step.observation.results.entries()) {
          const rp = `${sp}/observation/results/${ri}`;
          if (!record(result)) { issue(rp); continue; }
          optional(result, "source_call_id", rp, string);
          optional(result, "content", rp, content);
          optional(result, "subagent_trajectory_ref", rp, (refs) => Array.isArray(refs) && refs.every(record));
        }
      }
    }
    if (trajectory.subagent_trajectories != null) {
      if (!Array.isArray(trajectory.subagent_trajectories)) issue(`${pointer}/subagent_trajectories`);
      else trajectory.subagent_trajectories.forEach((child, index) => {
        if (record(child)) visit(child, `${pointer}/subagent_trajectories/${index}`);
        else issue(`${pointer}/subagent_trajectories/${index}`);
      });
    }
  };
  visit(document, "#");
  return diagnostics;
}

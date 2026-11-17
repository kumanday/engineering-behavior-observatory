import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
const scenario = process.argv.find(a => a.startsWith("--scenario="))?.split("=")[1] ?? "success";
const selected = flag => process.argv[process.argv.indexOf(flag) + 1];
const conversation = "fixture-agy-conversation";
const usage = { input_tokens: 100, output_tokens: 20, thinking_tokens: 7, cache_read_tokens: 60, total_tokens: 120 };
const emit = value => process.stdout.write(JSON.stringify(value) + "\n");
if (scenario === "malformed") { process.stdout.write("not-json\n"); setInterval(() => {}, 1000); }
else if (scenario === "oversized") { process.stdout.write(JSON.stringify({ event: "future", text: "x".repeat(10000) }) + "\n"); setInterval(() => {}, 1000); }
else if (scenario === "startup-error") { emit({ event: "result", result: { conversation_id: "", status: "ERROR", num_turns: 0, error: "No authentication token profile." } }); process.exitCode = 1; process.stdin.resume(); }
else {
  emit({ event: "init", conversation_id: conversation, init: {
    cwd: process.cwd(), model: scenario === "wrong-model" ? "other-model" : selected("--model"),
    tools: ["read_file", "edit_file", "run_command"], permission_mode: process.argv.includes("--dangerously-skip-permissions") ? "always-proceed" : "request-review",
  } });
  const step = (index, state, type, fields = {}) => emit({ event: "step_update", step_update: {
    conversation_id: scenario === "foreign-step" ? "foreign-conversation" : conversation,
    step_index: index, state, step_type: type, ...fields,
  } });
  const reader = createInterface({ input: process.stdin });
  let inputs = 0;
  reader.on("line", line => {
    const input = JSON.parse(line); inputs++;
    if (input.event !== "user" || !input.message.content || inputs !== 1) process.exit(2);
    step(0, "DONE", "user_input");
    if (scenario === "hang" || scenario === "ignore-interrupt") {
      process.on("SIGINT", () => {
        if (scenario === "ignore-interrupt") return;
        emit({ event: "result", result: { conversation_id: conversation, num_turns: 1, status: "ERROR", finished_reason: "interrupted", error: "Interrupted by user", response: "", usage } });
        process.exit(1);
      });
      setInterval(() => {}, 1000); return;
    }
    step(1, "DONE", "agent_thought", { text_delta: "PRIVATE-AGY-REASONING-SENTINEL" });
    const call = { tool_name: "run_command", tool_info: { name: "run_command", parameters: { CommandLine: "npm test" } } };
    step(2, "ACTIVE", "tool", call); step(2, "ACTIVE", "tool", call);
    const tool = { ...call, duration_seconds: 0.1, tool_info: { ...call.tool_info, output: "1 test passed", ...(scenario === "tool-error" ? { error: { type: "execution", message: "failed" } } : {}) } };
    step(2, "DONE", "tool", scenario === "missing-tool-result" ? { tool_name: "run_command" } : tool); step(2, "DONE", "tool", tool);
    if (scenario === "subagent-start") step(3, "ACTIVE", "tool", { subagent_info: { subagents: [{ conversation_id: "fixture-child" }] } });
    step(3, "DONE", "tool", { subagent_info: { subagents: [{ conversation_id: "fixture-child", type_name: "research", role: "assistant", log_uri: "/private/log", workspace_uris: [process.cwd()] }] } });
    step(4, "ACTIVE", "agent_response", { text_delta: "DO" });
    step(4, "DONE", "agent_response", { text_delta: "NE", usage });
    if (scenario === "message-repeat") step(4, "DONE", "agent_response", { text_delta: "NE", usage });
    step(5, "DONE", "checkpoint", { usage: { ...usage, input_tokens: 1 } });
    if (scenario === "future") emit({ event: "future-event", unknown: { data: "retained" } });
    writeFileSync("capture-proof.txt", "done\n");
    if (scenario === "exit-only") return;
    const result = { event: "result", result: { conversation_id: scenario === "foreign-result" ? "another-conversation" : conversation,
      num_turns: scenario === "multi-turn" ? 2 : 1, status: scenario === "error" || scenario === "native-interrupted" ? "ERROR" : "SUCCESS", response: "DONE", usage,
      ...(scenario === "native-interrupted" ? {finished_reason:"interrupted",error:"Interrupted by user"} : {}),
      ...(scenario === "error" ? { error: "fixture native failure" } : {}) } };
    emit(result);
    if (scenario === "duplicate-result") emit(result);
    if (scenario === "linger") setInterval(() => {}, 1000);
  });
}

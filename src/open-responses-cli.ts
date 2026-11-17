import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { analyzeOpenResponsesRecording, loadOpenResponsesSchema, OPEN_RESPONSES_ENDPOINTS, type OpenResponsesEndpoint } from "./open-responses.js";
import { createOpenResponsesRecorder } from "./open-responses-recorder.js";

export const OPEN_RESPONSES_RECORDER_FORMAT = "ebo.open-responses-recorder/v1";

const usage = `Usage: ebo open-responses record <recording-root> <route-id> --upstream <base-url> --upstream-key-env <NAME> --route-key-env <NAME> [--endpoint <responses|chat/completions>] [--model <id>] [--host <address>] [--port <port>]
       ebo open-responses analyze <recording-root> <output.json> [--schema <openapi.json>]
`;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export type OpenResponsesCommandOptions = {
  env?: NodeJS.ProcessEnv;
  /** Stops `record`; SIGINT and SIGTERM stop it when no signal is supplied. */
  signal?: AbortSignal;
  /** Receives `record` diagnostics. Defaults to stderr so stdout stays free for a protocol channel. */
  diagnostics?: (text: string) => void;
};

export async function runOpenResponsesCommand(args: string[], write: (text: string) => void, options: OpenResponsesCommandOptions = {}): Promise<number> {
  const [command, first, second, ...rest] = args;
  const flags = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const name = rest[index]!;
    const value = rest[index + 1];
    if (!name.startsWith("--") || value === undefined || flags.has(name)) return invalid(command, write, options);
    flags.set(name, value);
  }
  if (first === undefined || second === undefined || first.startsWith("--") || second.startsWith("--")) return invalid(command, write, options);
  if (command === "analyze") {
    if ([...flags.keys()].some((name) => name !== "--schema")) return invalid(command, write, options);
    try {
      const schemaPath = flags.get("--schema");
      const report = analyzeOpenResponsesRecording(resolve(first), loadOpenResponsesSchema(schemaPath === undefined ? undefined : resolve(schemaPath)));
      writeFileSync(resolve(second), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      const routes = Object.values(report.routes);
      const finished = routes.reduce((sum, route) => sum + route.interoperability.requests.finished, 0);
      write(`Analyzed ${finished} finished requests in ${routes.length} routes against Open Responses ${report.specification.version} `
        + `(${report.specification.schema.source} schema sha256:${report.specification.schema.sha256}). Wrote ${resolve(second)}.\n`);
      return 0;
    } catch (error) {
      write(`${error instanceof Error ? error.message : "Open Responses analysis failed."}\n`);
      return 1;
    }
  }
  if (command !== "record") return invalid(command, write, options);

  const diagnostics = options.diagnostics ?? ((text: string) => { process.stderr.write(text); });
  const env = options.env ?? process.env;
  const allowed = ["--upstream", "--upstream-key-env", "--route-key-env", "--endpoint", "--model", "--host", "--port"];
  const upstream = flags.get("--upstream");
  const upstreamKeyEnv = flags.get("--upstream-key-env");
  const routeKeyEnv = flags.get("--route-key-env");
  const endpoint = (flags.get("--endpoint") ?? "responses") as OpenResponsesEndpoint;
  const port = flags.has("--port") ? Number(flags.get("--port")) : 0;
  if ([...flags.keys()].some((name) => !allowed.includes(name)) || upstream === undefined || upstreamKeyEnv === undefined || routeKeyEnv === undefined
      || !ENVIRONMENT_NAME.test(upstreamKeyEnv) || !ENVIRONMENT_NAME.test(routeKeyEnv) || !OPEN_RESPONSES_ENDPOINTS.includes(endpoint)
      || !Number.isSafeInteger(port) || port < 0 || port > 65535) {
    return invalid(command, write, options);
  }
  try {
    const upstreamCredential = env[upstreamKeyEnv];
    const token = env[routeKeyEnv];
    if (!upstreamCredential || !token) throw new Error(`Set ${upstreamKeyEnv} and ${routeKeyEnv} in the environment.`);
    const root = resolve(first);
    const model = flags.get("--model");
    const host = flags.get("--host") ?? "127.0.0.1";
    const recorder = createOpenResponsesRecorder({ root, upstreamBaseUrl: upstream, upstreamCredential });
    recorder.register({ id: second, endpoint, token, ...(model === undefined ? {} : { model }) });
    const listening = await recorder.listen(port, host);
    const baseUrl = `http://${host.includes(":") ? `[${host}]` : host}:${listening}/attempt/${second}/v1`;
    writeFileSync(join(root, second, "recorder.json"), `${JSON.stringify({
      schemaVersion: OPEN_RESPONSES_RECORDER_FORMAT, baseUrl, route: { id: second, endpoint, model: model ?? null },
      upstreamBaseUrl: upstream, credentialEnvironment: { upstream: upstreamKeyEnv, route: routeKeyEnv }, startedAt: new Date().toISOString(),
    }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    diagnostics(`Open Responses recorder listening at ${baseUrl}\n`);
    await new Promise<void>((stop) => {
      if (options.signal !== undefined) {
        if (options.signal.aborted) stop();
        else options.signal.addEventListener("abort", () => stop(), { once: true });
      } else {
        process.once("SIGINT", () => stop());
        process.once("SIGTERM", () => stop());
      }
    });
    await recorder.close();
    return 0;
  } catch (error) {
    diagnostics(`${error instanceof Error ? error.message : "Open Responses recorder failed."}\n`);
    return 1;
  }
}

function invalid(command: string | undefined, write: (text: string) => void, options: OpenResponsesCommandOptions): number {
  if (command === "record") (options.diagnostics ?? ((text: string) => { process.stderr.write(text); }))(usage);
  else write(usage);
  return 2;
}

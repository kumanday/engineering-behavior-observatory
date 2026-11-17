# Open Responses through Pi

[Open Responses](https://www.openresponses.org/specification) is a published specification for Responses-style model APIs. EBO supports it in three parts: Pi can run a task against a Responses endpoint, a recording proxy retains the HTTP traffic of that run, and an analyzer checks the retained traffic against the specification's schema. The pinned specification version is **2026-04-24**.

EBO has one Responses client, the [Pi harness](pi-sdk.md). The other harnesses use their own native protocols and are outside this page.

## Run Pi against a Responses endpoint

Set `api: "openai-responses"` in the Pi model record and point `baseUrl` at the endpoint's `/v1` root. Everything else in the [Pi guide](pi-sdk.md) applies unchanged: the run produces the same native session, event and observer artifacts, and capture qualification works the same way.

Pi sends `store: false` and replays the full conversation in each request, including every `function_call_output` for the tool calls of the previous response. EBO does not use `previous_response_id`.

Pi's own artifacts hold its messages, tool calls and usage. They do not hold the raw HTTP exchange. The observer records the request payload only when `includeProviderPayloads` is enabled, and it never sees the individual stream events. Use the recorder when you need the bytes.

## Record wire traffic

The recorder is an HTTP proxy that sits between Pi and the provider. Start one per attempt:

```sh
ebo open-responses record <recording-root> <route-id> \
  --upstream <provider-base-url> \
  --upstream-key-env <NAME> --route-key-env <NAME> \
  [--endpoint <responses|chat/completions>] [--model <id>] \
  [--host <address>] [--port <port>]
```

Both credentials come from the environment. `--upstream-key-env` names the variable that holds the provider credential, which only the recorder uses. `--route-key-env` names a variable that holds a token you choose for this attempt. Pi presents that token, so set the same variable as `apiKeyEnv` in the Pi model record and never give Pi the provider credential. The two values must differ.

The recorder listens on `127.0.0.1` and an operating-system-assigned port unless you pass `--host` or `--port`. When it is ready it writes `<recording-root>/<route-id>/recorder.json`, whose `baseUrl` is the value for the Pi model record's `baseUrl`. It prints one line to stderr and nothing to stdout, and it runs until it receives SIGINT or SIGTERM. A route ID is lowercase letters, digits and hyphens. An existing route directory is never reused, so a retry needs a new route ID.

A route accepts `POST` on one endpoint. `--endpoint chat/completions` records a Chat Completions control run for comparison. With `--model`, a request that names another model is rejected with HTTP 400 before it is forwarded.

Pi requests grow with the conversation, and some gateways reject large bodies. Setting `requestCompression: "gzip"` in the Pi harness record makes Pi compress each request. The recorder decodes it, checks the declared size and SHA-256, and forwards the original bytes uncompressed.

### What is retained

Each request gets a numbered directory under the route, with files readable only by the owner:

| File | Contents |
|---|---|
| `request.json` | the request body exactly as Pi produced it, after gzip decoding |
| `response.bin` | the upstream response body, byte for byte in the order received, including a partial stream after cancellation or an upstream failure |
| `receipt.json` | endpoint, declared model, HTTP status, content type, body sizes and SHA-256 digests, request and forwarded header names, start and end times, and the usage object, response ID and terminal event type when the stream supplied them |

A receipt field is `null` when the response did not supply it. A request directory without a receipt is still in flight or was interrupted.

The recorder forwards the request body unchanged and adds nothing to it. It forwards Pi's request headers except hop-by-hop headers, `authorization`, `x-api-key`, `api-key`, `cookie`, and the encoding headers it has already resolved, then sets `authorization` to the provider credential. Receipts list header names only. No header value, route token or provider credential is written to disk, and both secrets are removed from any error message before it is recorded or returned.

Request and response bodies contain prompts, tool output and model text. Treat the recording root as restricted evidence. It is separate from the run bundle, and `ebo export create` does not include it.

## Analyze a recording

```sh
ebo open-responses analyze <recording-root> <output.json> [--schema <openapi.json>]
```

The analyzer reads every route under the recording root and writes an `ebo.open-responses-wire-analysis/v1` report to a new file. It calls no model and makes no network request. The report names the specification version and the SHA-256 of the schema it used.

By default the schema is the specification's 2026-04-24 OpenAPI document, vendored unmodified under `contracts/open-responses-2026-04-24/` with its source, upstream commit, Apache-2.0 licence and digest in `manifest.json`. `--schema` substitutes another OpenAPI document; the report then records that file's digest and declared version and marks the schema `caller-supplied`.

For each Responses request with a successful event-stream response, the analyzer checks:

- **Event schema.** Each event is validated against the schema for its `type`. A type the schema does not list counts as a violation unless it carries an implementor prefix such as `acme:trace`, which the specification reserves for extensions; those are counted separately.
- **SSE event names.** The `event:` field of each frame must equal the `type` in its data. A frame with no `event:` field counts as a deviation.
- **Sequence numbers.** Each `sequence_number` must follow the previous one.
- **Terminal response object.** The `response` in a `response.completed`, `response.failed` or `response.incomplete` event is validated against `ResponseResource`.
- **Tool-result replay.** Each request must carry a `function_call_output` for every function call of the last completed response. A failed response or HTTP error leaves that expectation in force for the retry.

The report keeps two blocks apart for each route. `interoperability` describes what happened on the wire: finished and in-flight requests, terminal event types, HTTP and transport errors, and tool-result replay. `conformance` holds the schema results. A provider can deviate from the schema while Pi still completes every request, and the reverse, so read them separately.

Whether the agent finished its task is not in this report. That comes from the Pi run summary and the bundle's capture qualification.

A check that had nothing to examine reports why. Each request carries a status of `checked`, `not-applicable` or `unavailable` with a reason, and a route-level count is `null` when no request could be checked. For example, a route whose only response was an HTTP 429 reports `eventSchemaViolations: null`, and a Chat Completions route reports conformance as not applicable.

The report contains event type names, tool names, call IDs, schema locations and counts. It copies no prompt, completion or reasoning text, and keeps at most eight schema errors per violation along with the total. It is written owner-readable; keep it with the recording.

## Not covered

- **Stored responses.** `previous_response_id` continuation, `store: true`, background responses and response retrieval are not exercised. A request that continues a stored response is marked not applicable for replay.
- **Other transports and dialects.** The recorder handles `POST /v1/responses` and `POST /v1/chat/completions` over HTTP. It has no route for Anthropic Messages, Google Generative AI or WebSocket transports.
- **Non-streaming responses.** A response that is not an event stream is retained but reported as unavailable for conformance.
- **Request conformance.** The analyzer validates what the provider returned. It does not validate Pi's request bodies against the specification's request schema.
- **Run-bundle integration.** Recordings are not run-bundle artifacts. They are not normalized, cited by uniform events, exported or shown in Atlas.
- **Live qualification.** The checks in this repository use authored fixtures and a local stand-in server. No provider route is qualified by them; verify a live route with a recorded run before relying on it.

## Validation

```sh
npm run build
node --test dist/test/open-responses.test.js dist/test/pi-http-transport.test.js
node --test --test-name-pattern='wire recorder' dist/test/pi.test.js
```

The last command runs the bundled Pi SDK through the recorder against a local Responses stand-in for one tool round, then analyzes the recording.

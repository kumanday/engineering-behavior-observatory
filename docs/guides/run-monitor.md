# Run monitor

`ebo monitor` is a live dashboard for a campaign in progress: which attempts are pending, running, quiet or done,
what they cost so far, how close each is to its wall-clock and budget limits, and what their native streams are doing.

```sh
ebo monitor campaign-status.json            # http://127.0.0.1:13013
ebo monitor campaign-status.json --port 13014 --interval 2000
```

It needs no build step beyond the package. Start it as soon as the runner has written its status file; it keeps
running until stopped. Run one monitor per campaign, with another `--port` for a second one.

## Inputs

Running studies is an operation that consumes EBO, so the monitor reads two kinds of input:

| Input | Owner | Provides |
| :--- | :--- | :--- |
| `ebo.campaign-status/v1` file ([schema](../../schemas/campaign-status.v1.json)) | the campaign runner | campaign state (`planned`, `running`, `paused` for a runner waiting on an operator decision, `finished`, `failed`, `stopped`) with an optional `note`, stage, deadline, runner PID, limits, account credit at start, model order, every planned attempt and probe with its state, times, budget, live spend and paths below |
| Each attempt's EBO run bundles (`runBundles`) | EBO capture | harness version, latest capture-report qualification, terminal state once the attempt ended, native stream record counts, event type names and tool calls started |
| Each attempt's request log (`requestLog`, optional) | the runner's model proxy | per-response time, prompt/completion/cached/reasoning tokens and cost (OpenAI-compatible `usage` objects) |

The runner rewrites the status file in place (write a temporary file and rename it). Relative paths resolve against
the status file's directory. A minimal file:

```json
{
  "format": "ebo.campaign-status/v1",
  "campaign": { "id": "my-campaign", "state": "running", "startedAt": "2026-10-13T20:00:00Z", "updatedAt": "2026-10-13T20:05:00Z", "runnerPid": 4242 },
  "limits": { "maxConcurrent": 2, "wallClockPerAttemptMs": 7200000, "budgetPerAttemptUsd": 100 },
  "account": { "provider": "OpenRouter", "creditAtStartUsd": 60 },
  "models": ["vendor/model-a"],
  "attempts": [
    { "id": "run-pi-1", "model": "vendor/model-a", "harness": "pi-sdk", "replicate": 1, "state": "running",
      "startedAt": "2026-10-13T20:00:05Z", "budgetUsd": 100, "maxWallClockMs": 7200000,
      "runBundles": "attempts/run-pi-1/runs", "requestLog": "attempts/run-pi-1/usage.jsonl",
      "spend": { "chargedUsd": 1.25, "reservedUsd": 5, "requests": 30, "lastResponseAt": "2026-10-13T20:04:58Z" } },
    { "id": "run-pi-2", "model": "vendor/model-a", "harness": "pi-sdk", "replicate": 2, "state": "pending", "budgetUsd": 100 }
  ]
}
```

## What it shows

- Attempts done out of planned, charged and in-flight reserved spend, estimated remaining account credit (credit at
  start minus charged, flagged when pending budgets exceed it), deadline countdown, requests, tokens and cache rate.
- An attempt matrix (model × harness × replicate) and, for running attempts, wall-clock and budget bars, the time since
  the last model response (quiet after two minutes), requests, tool calls, native records, context per request and
  cumulative cost.
- Spend over time per attempt (color by harness, line pattern by model), preflight probes, per-attempt detail with
  native event type counts, and state changes seen since the monitor started.

A running attempt's bundle manifest carries a provisional terminal state; the monitor shows the terminal only after
the status file marks the attempt ended. Tool calls are counted from each harness's native vocabulary (Pi, Codex,
Claude Agent SDK); other harnesses show `n/a`, not zero. All figures are live and unaudited; certified numbers come
from [aggregation](../evaluation/aggregation.md).

## Boundaries

The snapshot (`/snapshot.json`, `ebo.monitor-snapshot/v1`; the page receives it over Server-Sent Events at `/events`)
is an allowlist: it never includes prompts, completions, commands, tool arguments or results, logs, credentials or
paths outside the status file's directory. The server binds 127.0.0.1, rejects non-loopback hosts and origins,
answers only `GET`/`HEAD`, and serves only its own page and the Atlas viewer tokens, never campaign files.

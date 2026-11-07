# Native v2 projections

`createRetainedBehaviorEvidenceV2` reads an owned, capture-qualified bundle and
creates an independent `ebo.normalized-dataset/v2` derivation. Capture admission
continues to verify the retained producer and capture-adapter versions. The
original native files, manifest and v1 dataset remain available through their
supported readers.

```ts
const evidence = await createRetainedBehaviorEvidenceV2(bundleRoot);
await validateNormalizedDatasetV2(evidence.dataset, evidence.resolver);
```

The fixed registry supports Claude Agent SDK, Pi, Codex app-server, DeepSeek
Harness, OpenHands Agent Server, Factory Droid, Cursor SDK and Devin CLI/ACP.
`listNativeV2Profiles` exposes their implementation identities. Imported ATIF
requires its own producer profile and retains imported qualification.

Each source profile interprets its retained records and supplies message,
context, clock, resource and operation facts. A shared builder owns operation
identity, endpoint membership and disagreement handling. Calls, completed
results and partial observations have separate event lists. Pending operations
keep unknown failure. Conflicting explicit source observations also keep
failure unknown.
Each result carries its own failure fact, so a follow-up extractor can cite the
endpoint that records failure. A record-local identity retains unknown logical
scope. Resource facts identify their population independently of the numeric
value; a missing population identifier stays unknown.

| Source | Operation and evidence boundary |
| --- | --- |
| Claude Agent SDK | Native tool-use IDs bind message blocks and uniquely scoped hook copies. Tool-batch callbacks remain aggregate runtime evidence. Session and parent-tool scopes distinguish child activity. |
| Pi | Persisted issuing-message identities establish branch scope. Recorded tool calls remain visible when no execution result exists. Stream/history copies join only with an established source binding. A shared model-output boundary groups sibling calls without asserting an inference count. Preparation failures remain partial. Observer-generated provider labels are EBO-derived identities. |
| Codex | Item identities bind within native thread and turn scopes. Owned started items survive as pending calls. Foreign thread and turn notifications remain retained evidence. Per-request usage increments and cumulative session snapshots remain separate. |
| DeepSeek Harness | Session events retain their native sequence domain. Pinned tool-role results and retained multi-call result messages preserve their explicit tool bindings. Transport recorder order supplies no missing native precedence. |
| OpenHands | Conversation scope and native action/observation relations bind operations. Source timestamps remain producer observations. REST and WebSocket evidence keep their declared order domains. |
| Factory Droid | Session scope binds tool-use IDs. Session snapshots and owned-turn totals inclusive of children retain separate resource scopes. |
| Cursor | Missing tool status remains a partial observation. Collector sequence is presentation order. Tool success requires explicit source result evidence. |
| Devin CLI/ACP | Session tool-call IDs bind terminal updates, including a previously recorded terminal exit. Message chunks remain partial; receipt clocks retain their own provenance. |

The derivation records the executed harness separately from source-container,
reader and profile identities. Its implementation digest binds the coordinating
projector, operation builder, source profile, evidence-pointer implementation,
contract validator and v2 schema. Native record coverage accounts for every
retained record as mapped, retained-only or unmapped.

The resolver computes canonical pointed-value digests for both JSONL locators
and document pointers. A JSONL line has its own pointer namespace. Nested
records must agree with their retained parent. Independent workspace artifacts
retain their own content digests and attempt identity. The reader never fetches
an external reference or executes reader code supplied by a packet.

Clocks distinguish native producer observations, passive hook callbacks and
EBO receipt time. Native timestamp presence alone does not qualify execution
duration. `precedes` compares established native order domains; timestamps and
presentation order do not establish a missing behavioral relation.

The v2 API is opt-in while typed consumers and migration reconciliation pass
their gates. Current v1 entry points retain their published contracts. A release
candidate must also pass the native baseline, package and mixed-runtime tests
described in [migration accounting](migration-accounting.md).

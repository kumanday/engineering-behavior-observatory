# Evidence interpretation limitations

These codes qualify particular facts or populations. A limitation does not erase
recorded content. Unknown values differ from observed zeroes. Imported document
measures remain available alongside limitations on completeness or native semantics.

## Source and version confidence

| Code | Meaning |
| --- | --- |
| `THIRD_PARTY_SOURCE` | The evidence is imported rather than captured by the current EBO attempt. |
| `CAPTURE_COMPLETENESS_UNPROVEN` | The recorded document does not establish the complete attempt history. |
| `ATIF_MINOR_VERSION_UNVERIFIED` | A v1 minor outside the known set is read with compatible known semantics; unfamiliar fields remain unmapped. |
| `ATIF_VERSION_FIELD_UNVERIFIED` | A field appears outside its declared minor version's feature contract and receives no newer semantics from its presence alone. |
| `ATIF_MAJOR_VERSION_UNSUPPORTED` | The document's major format requires a reader implementation that EBO does not provide. |
| `ATIF_CHILD_FORMAT_UNSUPPORTED` | A retained child has an unsupported format; the readable parent remains available. |
| `ATIF_FIELD_UNRECOGNIZED` | A field is retained without a known standard interpretation. |
| `ATIF_EXTENSION_OPAQUE` | An extension is retained without core interpretation. |
| `PRODUCER_VERSION_UNVERIFIED` | A matching overlay's agent or converter version is outside its verified ranges; core and conservative limitations apply. |
| `HARNESS_VERSION_UNVERIFIED` | A retained native runtime or capture-adapter version lacks verified conformance evidence; its format contract is still read. |
| `HARNESS_VERSION_CONFLICT` | Retained version declarations disagree. The disagreement is visible and the executed version remains uncertain. |
| `ATIF_TRIAL_AGENT_VERSION_UNVERIFIED` | An ATIF or trial version declaration is missing, unknown or conflicting; source association retains the uncertainty. |
| `NO_OVERLAY_APPLIED` | Core projection is available without a matching optional overlay. |
| `NO_MATCHING_OVERLAY` | The supplied agent/converter context matches no dedicated interpretation. |

## Recorded populations and references

| Code | Meaning |
| --- | --- |
| `CALL_COLLECTION_UNREPORTED` | No new-behavior call collection is recorded, so its count is unknown. |
| `TOOL_FAILURE_NOT_IN_ATIF_CORE` | Standard ATIF supplies no tool-failure field. |
| `DECLARED_INFERENCE_INCOMPLETE` | At least one relevant agent step lacks a usable declared inference count. |
| `NATIVE_REQUEST_IDENTITIES_UNAVAILABLE` | Recorded inference declarations do not establish provider request identities. |
| `RESULT_CHRONOLOGY_UNRECORDED` | A result record does not establish its arrival order. |
| `AMBIGUOUS_TOOL_CALL_ID` | Several calls in one step declare the same identity; their results cannot be assigned to a particular call. |
| `SOURCE_IDENTITY_UNREPORTED` | The record lacks a usable source identity; a local observation identity cannot prove a logical operation. |
| `SOURCE_UNREPORTED` | The source does not supply the fact. |
| `RETAINED_SOURCE_WITHOUT_CORE_EVENT` | The record remains available without a corresponding standard event. |
| `REFERENCE_NOT_ADMITTED` | A referenced local file has not been explicitly admitted. |
| `REFERENCE_MISSING_UNSAFE_OR_OVERSIZED` | A reference could not be admitted under file and size limits. |
| `SESSION_REFERENCE_NOT_RETAINED` | A session-only child reference has no retained child document. |
| `EMBEDDED_REFERENCE_MISSING_OR_AMBIGUOUS` | An embedded trajectory identity is absent or cannot be resolved uniquely. |
| `EXTERNAL_REFERENCE_UNAVAILABLE` | A reference cannot be resolved from admitted local evidence. |

## Optional converter qualifications

| Code | Meaning |
| --- | --- |
| `BRANCH_HISTORY_MAY_BE_OMITTED` | Conversion can select an active branch and omit other native history. |
| `PRODUCER_PARTIAL_HISTORY` | A matched overlay identifies an explicit partial-history extension. |
| `CONVERTER_ZERO_FILL_POSSIBLE` | A converter can substitute a default zero or false for missing native evidence. |
| `PI_CACHE_COMPONENTS_UNPROVEN` | Pi's inclusive prompt count lacks the components needed to establish uncached input. |
| `PI_INCLUSIVE_PROMPT_CONFLICT` | Pi prompt/cache components imply a negative uncached input. |
| `STEP_FINAL_USAGE_CONFLICT` | Recorded step usage and final usage disagree. |
| `USAGE_COMPONENT_COMPLETENESS_UNPROVEN` | Component totals lack a complete set of independently tracked inference observations. |
| `CONVERTER_OMITS_PENDING_CALLS` | Conversion can omit native calls without results. |
| `CONVERTER_REORDERS_MODEL_OUTPUTS` | Converted step positions cannot establish native interleaving order. |
| `CONVERTER_MAY_SPLIT_INFERENCE_GROUPS` | Several converted steps can describe one converter inference group. |
| `CONVERTER_INFERENCE_GROUP_UNAVAILABLE` | Retained grouping evidence is missing or inconsistent. |
| `CONVERTER_ARGUMENT_NORMALIZATION_MAY_BE_LOSSY` | Converted argument objects can collapse distinct native representations. |
| `CONVERTER_ARGUMENT_PROVENANCE_INCOMPLETE` | Original input provenance cannot establish native input equality. |
| `CONVERTER_MAY_FABRICATE_CALLS_FOR_ORPHAN_RESULTS` | Conversion can create call entries for outputs whose calls are absent. |
| `BUILTIN_RESULT_SLOTS_MAY_BE_SYNTHETIC` | A built-in tool's result slot may be a converter placeholder. |
| `CONVERTER_GROUPED_CLOCKS` | Converted timestamps describe grouped producer observations, not tool execution boundaries. |
| `TOOL_FAILURE_NOT_PROJECTED` | The converter does not project native tool-failure status. |

Adjustment receipts also name the interpretation rule, such as Pi's explicit
error extension or Codex's original argument representation. These rule names
explain a transformation; the tables above define its availability limits.
Structural validation diagnostics identify malformed fields or bounded-reader
failures separately from these analytical qualifications.

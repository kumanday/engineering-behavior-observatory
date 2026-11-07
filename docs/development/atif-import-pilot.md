# ATIF import pilot: 2026-11-07

The pilot supports an additive Pi import path with separate qualification. It
also supplies an occurrence-ordering regression for imported events. Production admission and full-corpus
evaluation are implementation tasks in the ATIF/v2 planning wave.

## Sample and method

The EBO source base is `86a601079a51243756fe52798365a9cbf69cfe6f` (1.4.0).
The pilot uses Node 24.19.0, Python 3.13.12, Harbor 0.24.0 and atif-scan 0.8.21.
It retrieves a purposeful sample of four public trial directories, retains
source-byte SHA-256/xet receipts, and converts three private Pi sessions twice
through Harbor's pinned Pi converter. The sample is for mapping fidelity; it
cannot estimate leaderboard behavior rates.

| Public sample | ATIF | Recorded tool calls | Native companion calls | Finding |
| --- | --- | --- | --- | --- |
| Pi | v1.7 | 28 | 28 | Explicit error fields; prompt/cache semantics reconcile |
| Hermes | v1.2 | 28 | Not implemented in pilot | Inference count is untracked; v1.2 support is necessary |
| OpenClaw | v1.8 | 0 recorded | Native session unavailable | Partial-history marker; full-attempt tool count stays unknown |
| Codex pending-call case | v1.7 | 44 | 45 | One unanswered native call is absent from ATIF |

All four pass Harbor's pinned structural model validation. This does not
establish completeness. The Codex document references images outside the
retained sample; they remain unavailable and were not automatically fetched.
The three Pi conversions are byte-identical across their two runs.

The acquisition retains 47 public-source files totaling 2,915,673 bytes. An
identical replay verifies retained digests and returns a no-op. The receipt
records source URLs, retrieval time, file hashes, xet hashes and restricted
sharing class. A changed upstream snapshot requires a new destination; this
pilot does not implement production revision discovery or reuse selection.

## Same-run Pi checks

The development projector emits pointer-addressed uniform events and validates
the existing `ebo.normalized-dataset/v1` shape. All members of one step retain
the same ordinal; no per-tool clock or source-native request ID is invented.
The current Atlas unit builder also accepts those projections.

| Pair | Native admission | Recorded calls | Five-measure agreement | Operation signatures | Declared inferences / native requests |
| --- | --- | --- | --- | --- | --- |
| A | Accepted | 105 | 5/5 | Equal | 77 / 77 |
| B | Accepted | 45 | 5/5 | Equal | 22 / 22 |
| C | Rejected | 291 in converted source | Not eligible | Not eligible | 276 / unavailable |

The five measures are tool operations, explicit tool errors, uncached input
tokens, output tokens and cache-read tokens. Signatures compare original call
ID, tool name and failure state. These are selected gates on two fixtures,
not qualification of every Pi producer/version or every EBO extractor.

Pair A's ATIF prompt total is 11,547,486, including 11,053,922 cached input tokens
and zero recorded cache-write tokens. Subtraction gives 493,564 uncached input
tokens, matching EBO's native measure. A direct prompt-to-input mapping would
overstate uncached input by about 23.4 times.

Pair C demonstrates the qualification boundary: Harbor converts the session
into structurally valid ATIF, while EBO's native loader rejects its evidence.
The experimental projection is retained for inspection with
`productionEligible: false`. It is never added to a corpus, capture-qualified
rate, comparative aggregate or judge batch.

## Ordering and tooling findings

The baseline ordering probe creates a failed operation whose result has source
ordinal 2 and no timestamp, followed by a timed call at ordinal 3 in the same
domain. Rules 1.2.0 associate that later call by source order. The frozen 1.1.0
baseline receipt demonstrates the defect independently of ATIF conversion.

The reader/profile split is necessary: Pi error fields, untracked Hermes
inference counts, OpenClaw partial markers and Codex pending-call loss have
different interpretations. ATIF step timestamps cannot supply tool timings.
`lock.json` exists in all four public samples but establishes no Harbor version
field; converter version needs another pinned source/configuration receipt.

`atif-scan` loads and scans all four local public inputs. Its root tool-call
inventory agrees with the pilot reader. Scanner results are review candidates;
they neither qualify capture nor certify native fidelity. The tool is useful as
an integrity/ending classifier and differential oracle, while EBO retains its
own raw bytes, source references and admission rules.

EBO's text secret scanner processed the 47 retained public files and reported
zero matches. That result makes no claim about token-ID arrays, unknown
extensions, binary media, or redistribution rights. Raw sample files and private
Pi pairs remain outside Git.

## Compatibility accounting

The inventory inspects two named study roots with explicit directory and 2 MiB
JSON limits. It parses schema identities and deduplicates canonical content,
rather than counting strings that resemble assertion names. It is a bounded
migration input, not a workspace census or an approved re-judge population.
It found 308 assertion files with 299 distinct canonical content digests across
38 dataset digests, 306 semantic-judgment files with 298 distinct content
digests, and 37 distinct structural observation sets. No occurrence-rating files
matched this selection. Judgment records bind their input digest; resolving
those inputs to datasets remains part of dependency accounting. These counts
describe the selected roots and filters; they do not establish affected
attempt/dimension/evaluator units.
Its file-level receipts are in `compatibility-inventory.json` under the private
pilot directory. Full attempt/dimension/evaluator dependency accounting remains
an implementation gate.

## Reproduction and limits

The [development tooling README](https://github.com/kumanday/engineering-behavior-observatory/tree/develop/scripts/atif-import-pilot)
documents acquisition, independent conversion, projection, scanning, inventory
and focused tests. The eleven synthetic tests cover source pointers, equal
step order, absent clocks/request identities, deterministic projection, unknown
failure, baseline ordering, version-label mismatch, partial histories and
reference confinement, interrupted acquisition retention and emitted evaluation
schema inventory and unavailable usage totals.

The pilot changes no runtime source, releases no package, executes no candidate
code and makes zero model calls. It does not implement `ebo atif import`, a
production import manifest, full profile qualification, final Atlas/aggregation
integration, the complete native readback census or a semantic judge study.

Public source cases:

* [Pi trial](https://huggingface.co/buckets/joelniklaus/harness-leaderboard/tree/runs/20261018-191100-glm-5-3-flash-full-low-3c31/terminal-bench-2.1/adaptive-rejection-sampler__E5tQWPd)
* [Hermes trial](https://huggingface.co/buckets/joelniklaus/harness-leaderboard/tree/runs/20261018-191100-glm-5-3-flash-full-low-3c31/terminal-bench-2.1/adaptive-rejection-sampler__3SLWJee)
* [OpenClaw trial](https://huggingface.co/buckets/joelniklaus/harness-leaderboard/tree/runs/20261018-191100-glm-5-3-flash-full-low-3c31/terminal-bench-2.1/adaptive-rejection-sampler__3hz5Qds)
* [Codex trial](https://huggingface.co/buckets/joelniklaus/harness-leaderboard/tree/runs/20261030-015111-deepseek-v4-1-flash-full-low-1200/terminal-bench-2.1/extract-moves-from-video__PQuRNAE)

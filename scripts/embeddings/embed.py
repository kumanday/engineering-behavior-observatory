"""Embed Atlas unit texts with EmbeddingGemma 2 through SentenceTransformers.

EBO's bundle builder runs this with the pinned runtime in requirements.txt. It reads one JSON string per line from
--input and writes float32 little-endian vectors, one row per input line in input order, to --output. Each vector is
the published SentenceTransformers graph's output (mean pooling, then L2 normalization) for the text with the model
card's clustering prompt, truncated to --dimensions and normalized again. --stats receives the device, precision,
batch limits, package versions and throughput. Progress goes to stderr as one JSON object per line; a progress line
reporting `embedded` comes after those rows are flushed to --output, so a caller can keep them if a later batch fails.

Batches are sized by tokens, not texts: throughput depends on tokens, and memory on the batch's padded token count.
Each batch holds texts of similar length, at most --batch-size of them and at most --token-budget padded tokens, and
every text is cut to --max-tokens. A batch that still runs out of device memory is halved and retried.
"""

import argparse
import json
import platform
import sys
import time

CHUNK = 16384  # texts read, length-sorted and written per step: bounded memory, and a rerun resumes from the last chunk
# Padded tokens per batch. On a 24 GB CUDA card in bfloat16 a budget of 32,768 peaked near 19 GB with 2,048-token
# texts (attention grows with length squared); 16,384 leaves headroom and, throughput being token-bound, costs nothing.
TOKEN_BUDGET = {"cuda": 16384, "mps": 16384, "cpu": 8192}
BATCH_LIMIT = {"cuda": 512, "mps": 128, "cpu": 64}


def log(**fields):
    print(json.dumps(fields), file=sys.stderr, flush=True)


def pick_device(requested, torch):
    if requested != "auto":
        return requested, None
    if torch.cuda.is_available():
        return "cuda", None
    if getattr(torch.backends, "mps", None) is not None and torch.backends.mps.is_available():
        return "mps", None
    return "cpu", "No CUDA or MPS device is available; embedding on CPU, which is much slower."


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--revision", required=True)
    parser.add_argument("--dimensions", type=int, required=True)
    parser.add_argument("--prompt-name", default="Clustering")
    parser.add_argument("--batch-size", type=int, default=0, help="most texts per batch; 0 picks one for the device")
    parser.add_argument("--token-budget", type=int, default=0, help="most padded tokens per batch; 0 picks one for the device")
    parser.add_argument("--max-tokens", type=int, default=2048, help="tokens kept per text, prompt included")
    parser.add_argument("--device", default="auto", choices=["auto", "cuda", "mps", "cpu"])
    parser.add_argument("--input")
    parser.add_argument("--output")
    parser.add_argument("--stats")
    parser.add_argument("--check", action="store_true", help="load the model, embed one text and exit")
    args = parser.parse_args()
    if not args.check and not (args.input and args.output and args.stats):
        parser.error("--input, --output and --stats are required unless --check is given")

    import numpy as np
    import sentence_transformers
    import torch
    import transformers
    from sentence_transformers import SentenceTransformer

    device, warning = pick_device(args.device, torch)
    if warning:
        log(warning=warning)
    # The model card: bfloat16 where the hardware supports it, float32 elsewhere; never float16 (its activations
    # overflow float16 and give NaN or degraded vectors without an error).
    dtype = torch.bfloat16 if device == "cuda" and torch.cuda.is_bf16_supported() else torch.float32
    batch = args.batch_size or BATCH_LIMIT[device]
    budget = args.token_budget or TOKEN_BUDGET[device]
    model = SentenceTransformer(args.model, revision=args.revision, device=device, model_kwargs={"torch_dtype": dtype})
    # The tokenizer's own limit is unbounded; without a cap one long text sets the whole batch's memory.
    model.max_seq_length = args.max_tokens
    prompt = model.prompts.get(args.prompt_name) or ""
    native = model.get_sentence_embedding_dimension()
    if args.dimensions > native:
        raise SystemExit(f"{args.model} produces {native} dimensions; {args.dimensions} were requested.")
    truncate = None if args.dimensions == native else args.dimensions
    log(device=device, dtype=str(dtype).replace("torch.", ""), batchSize=batch, tokenBudget=budget, maxTokens=args.max_tokens, dimensions=args.dimensions)
    if args.check:
        # The bundle build runs this before reading any attempt, so a broken runtime fails in seconds, not hours.
        vector = model.encode(["runtime check"], prompt_name=args.prompt_name, truncate_dim=truncate, normalize_embeddings=True, convert_to_numpy=True)
        if vector.shape != (1, args.dimensions) or not np.isfinite(vector).all():
            raise SystemExit(f"The runtime check returned shape {vector.shape} or non-finite values.")
        print(json.dumps({"ok": True, "device": device, "dtype": str(dtype).replace("torch.", ""), "dimensions": args.dimensions}))
        return

    def encode(texts):
        return model.encode(texts, prompt_name=args.prompt_name, batch_size=len(texts), truncate_dim=truncate,
                            normalize_embeddings=True, convert_to_numpy=True, show_progress_bar=False).astype(np.float32, copy=False)

    def encode_fitting(texts):
        # Halve a batch that runs out of device memory; a single text that still does not fit is an error.
        try:
            return encode(texts)
        except torch.OutOfMemoryError:
            if len(texts) == 1:
                raise
            if device == "cuda":
                torch.cuda.empty_cache()
            half = len(texts) // 2
            log(retry="out of device memory", texts=len(texts), halves=[half, len(texts) - half])
            return np.concatenate([encode_fitting(texts[:half]), encode_fitting(texts[half:])])

    started, count = time.monotonic(), 0
    with open(args.input, encoding="utf-8") as source, open(args.output, "wb") as sink:
        while True:
            texts = []
            for line in source:
                texts.append(json.loads(line))
                if len(texts) == CHUNK:
                    break
            if not texts:
                break
            # Token-sorted batches waste little padding; rows are written back in input order.
            lengths = token_counts(model.tokenizer, [prompt + t for t in texts], args.max_tokens)
            order = sorted(range(len(texts)), key=lambda i: lengths[i])
            out = np.empty((len(texts), args.dimensions), dtype=np.float32)
            for members in batches(order, lengths, batch, budget):
                vectors = encode_fitting([texts[i] for i in members])
                if not np.isfinite(vectors).all():
                    raise SystemExit("The model returned non-finite values.")
                out[np.asarray(members)] = vectors
            sink.write(out.astype("<f4", copy=False).tobytes())
            sink.flush()
            count += len(texts)
            elapsed = time.monotonic() - started
            log(embedded=count, seconds=round(elapsed, 1), textsPerSecond=round(count / elapsed, 1) if elapsed else None)

    seconds = time.monotonic() - started
    stats = {
        "model": args.model, "revision": args.revision, "promptName": args.prompt_name,
        "prompt": model.prompts.get(args.prompt_name), "dimensions": args.dimensions, "nativeDimensions": native,
        "device": device, "deviceName": torch.cuda.get_device_name(0) if device == "cuda" else platform.processor() or platform.machine(),
        "dtype": str(dtype).replace("torch.", ""), "batchSize": batch, "tokenBudget": budget, "maxTokens": args.max_tokens, "texts": count, "seconds": round(seconds, 3),
        "textsPerSecond": round(count / seconds, 1) if seconds else None,
        "packages": {"python": platform.python_version(), "torch": torch.__version__, "transformers": transformers.__version__,
                     "sentence-transformers": sentence_transformers.__version__, "numpy": np.__version__},
        **({"warning": warning} if warning else {}),
    }
    with open(args.stats, "w", encoding="utf-8") as file:
        json.dump(stats, file)


def token_counts(tokenizer, texts, max_length):
    """Each text's token count with special tokens, cut to `max_length` as the model will see it."""
    return [len(ids) for ids in tokenizer(texts, add_special_tokens=True, truncation=True, max_length=max_length)["input_ids"]]


def batches(order, lengths, limit, budget):
    """Consecutive runs of `order` (sorted by token count, shortest first) whose padded size, members times the longest
    member's tokens, stays within `budget`, with at most `limit` members. A text longer than the budget goes alone."""
    current, longest = [], 0
    for i in order:
        size = max(longest, lengths[i])
        if current and (len(current) == limit or size * (len(current) + 1) > budget):
            yield current
            current, longest = [], 0
            size = lengths[i]
        current.append(i)
        longest = size
    if current:
        yield current


if __name__ == "__main__":
    main()

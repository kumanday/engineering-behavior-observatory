"""Lay out Atlas cloud units in two dimensions at bundle build time.

EBO's bundle builder runs this with the pinned runtime in requirements.txt (and requirements-gpu.txt for cuML). It reads
--embeddings (float32 rows of --dimensions) and --families (one family name per row, JSON lines) and writes --output:
float32 little-endian (x, y) pairs plus the row's neighbors, as described below. Each family is laid out separately,
as the viewer does in the browser: identical vectors are laid out once, the vectors are reduced to --pca dimensions
with PCA, and UMAP (cosine, 15 neighbors, minimum distance 0.1, seed 42) places them. cuML runs on a CUDA device; on
any other machine umap-learn runs on the CPU, and the stats say which ran.

Output layout: n rows of (x, y) float32, then n rows of --neighbors int32 row ids (-1 for none) and n rows of
--neighbors float32 distances, all in input row order. --stats receives the backend, device, timings and versions.
"""

import argparse
import json
import platform
import sys
import time


def log(**fields):
    print(json.dumps(fields), file=sys.stderr, flush=True)


def backend():
    try:
        import cupy
        if cupy.cuda.runtime.getDeviceCount() > 0:
            import cuml
            return "cuml", cuml.__version__
    except Exception:  # noqa: BLE001 - any import or device failure means the CPU path
        pass
    import umap
    return "umap-learn", umap.__version__


DIGEST_CHUNK = 65536


def distinct_rows(vectors, rows):
    """The family's distinct vectors and, per row, the index of its distinct vector.

    Rows are compared by a 128-bit digest, read from the memory-mapped input in chunks, so only the distinct vectors are
    ever copied: a family of millions of units with few distinct vectors needs memory for those few, not for every row."""
    import hashlib

    import numpy as np

    parts = []
    for start in range(0, len(rows), DIGEST_CHUNK):
        chunk = np.ascontiguousarray(vectors[rows[start:start + DIGEST_CHUNK]])
        parts.append(b"".join(hashlib.blake2b(row.tobytes(), digest_size=16).digest() for row in chunk))
    keys = np.frombuffer(b"".join(parts), dtype="V16")
    _, first, inverse = np.unique(keys, return_index=True, return_inverse=True)
    return np.ascontiguousarray(vectors[rows[first]]), inverse.reshape(-1)


def estimators(name, dims, neighbors, args):
    """PCA, UMAP and (for cuML) nearest neighbors for one family, built with each backend's own arguments."""
    if name == "cuml":
        from cuml.decomposition import PCA
        from cuml.manifold import UMAP
        from cuml.neighbors import NearestNeighbors
        # cuML's PCA takes no random_state: its eigendecomposition solver has no random step.
        return (PCA(n_components=dims),
                UMAP(n_neighbors=neighbors, n_components=2, metric="cosine", min_dist=args.min_dist, random_state=args.seed),
                NearestNeighbors(n_neighbors=neighbors + 1, metric="cosine"))
    import umap
    from sklearn.decomposition import PCA
    return (PCA(n_components=dims, random_state=args.seed),
            umap.UMAP(n_neighbors=neighbors, n_components=2, metric="cosine", min_dist=args.min_dist, random_state=args.seed),
            None)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--embeddings")
    parser.add_argument("--dimensions", type=int)
    parser.add_argument("--families")
    parser.add_argument("--output")
    parser.add_argument("--stats")
    parser.add_argument("--check", action="store_true", help="build the layout backend's estimators and exit")
    parser.add_argument("--pca", type=int, default=128)
    parser.add_argument("--neighbors", type=int, default=15)
    parser.add_argument("--min-dist", type=float, default=0.1)
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    import numpy as np

    name, version = backend()
    if args.check:
        # Building the estimators checks each backend's arguments, which an import alone would not.
        estimators(name, 2, 2, args)
        print(json.dumps({"ok": True, "backend": name, "backendVersion": version}))
        return
    if not all([args.embeddings, args.dimensions, args.families, args.output, args.stats]):
        parser.error("--embeddings, --dimensions, --families, --output and --stats are required unless --check is given")
    if name == "umap-learn":
        log(warning="No CUDA device with cuML is available; laying out with umap-learn on the CPU, which is much slower.")
    vectors = np.memmap(args.embeddings, dtype="<f4", mode="r").reshape(-1, args.dimensions)
    with open(args.families, encoding="utf-8") as source:
        families = np.asarray([json.loads(line) for line in source])
    n = len(families)
    if vectors.shape[0] != n:
        raise SystemExit(f"{vectors.shape[0]} vectors for {n} family labels.")
    k = args.neighbors
    xy = np.zeros((n, 2), dtype=np.float32)
    nb_ids = np.full((n, k), -1, dtype=np.int32)
    nb_dist = np.zeros((n, k), dtype=np.float32)
    timings = {}

    for family in sorted(set(families.tolist())):
        started = time.monotonic()
        rows = np.flatnonzero(families == family)
        unique, inverse = distinct_rows(vectors, rows)
        m = unique.shape[0]
        log(family=family, units=int(len(rows)), distinct=int(m))
        if m < 10:
            # Too few distinct vectors for UMAP: a deterministic circle, duplicates together (as the viewer does).
            angle = 2 * np.pi * np.arange(m) / max(m, 1)
            layout = np.stack([np.cos(angle), np.sin(angle)], axis=1).astype(np.float32)
            idx = np.full((m, 0), -1, dtype=np.int32)
            dist = np.zeros((m, 0), dtype=np.float32)
        else:
            dims = min(args.pca, unique.shape[1], m - 1)
            neighbors = min(k, m - 1)
            pca, model, knn = estimators(name, dims, neighbors, args)
            if name == "cuml":
                import cupy
                data = cupy.asarray(unique)
                reduced = pca.fit_transform(data) if dims < unique.shape[1] else data
                layout = cupy.asnumpy(model.fit_transform(reduced)).astype(np.float32)
                dist, idx = (cupy.asnumpy(a) for a in knn.fit(reduced).kneighbors(reduced))
            else:
                reduced = pca.fit_transform(unique) if dims < unique.shape[1] else unique
                layout = model.fit_transform(reduced).astype(np.float32)
                # umap-learn keeps its k-nearest-neighbor result on the model.
                idx, dist = model._knn_indices, model._knn_dists
            idx = np.asarray(idx, dtype=np.int64)
            dist = np.asarray(dist, dtype=np.float32)
        # Each unit takes its distinct vector's place and neighbors (other distinct vectors, mapped to their first row).
        first_row = np.full(m, -1, dtype=np.int64)
        first_row[inverse[::-1]] = rows[::-1]
        xy[rows] = layout[inverse]
        for j in range(min(k, idx.shape[1])):
            col = idx[inverse, j]
            own = col == inverse
            mapped = np.where((col >= 0) & ~own, first_row[np.clip(col, 0, m - 1)], -1)
            nb_ids[rows, j] = mapped
            nb_dist[rows, j] = np.where(mapped >= 0, dist[inverse, j], 0)
        timings[family] = round(time.monotonic() - started, 2)
        log(family=family, seconds=timings[family])

    with open(args.output, "wb") as sink:
        sink.write(xy.astype("<f4").tobytes())
        sink.write(nb_ids.astype("<i4").tobytes())
        sink.write(nb_dist.astype("<f4").tobytes())
    import sklearn
    stats = {"backend": name, "backendVersion": version, "device": "cuda" if name == "cuml" else "cpu", "units": n,
             "pca": args.pca, "neighbors": k, "minDist": args.min_dist, "seed": args.seed, "metric": "cosine", "familySeconds": timings,
             "packages": {"python": platform.python_version(), "numpy": np.__version__, "scikit-learn": sklearn.__version__}}
    with open(args.stats, "w", encoding="utf-8") as file:
        json.dump(stats, file)


if __name__ == "__main__":
    main()

// Query embedder for semantic permit search. Must match the pipeline's document embeddings:
// bge-small-en-v1.5, q8, CLS pooling, normalized, BGE query instruction. transformers.js loads from
// jsDelivr at a pinned version (its WASM runtime is too large to ship as a static asset).
const TRANSFORMERS_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1/dist/transformers.min.js";
const MODEL = "Xenova/bge-small-en-v1.5";
const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";

type Extractor = (
  input: string[],
  opts: { pooling: "cls"; normalize: boolean },
) => Promise<{ data: Float32Array; dims: number[] }>;
let extractor: Promise<Extractor> | null = null;

export async function embedQuery(text: string): Promise<Float32Array> {
  extractor ??= import(/* @vite-ignore */ TRANSFORMERS_URL).then(
    (lib: { pipeline: (task: string, model: string, opts: { dtype: string }) => Promise<Extractor> }) =>
      lib.pipeline("feature-extraction", MODEL, { dtype: "q8" }),
  );
  // A failed load (network, CDN) is not cached, so the next search tries again.
  extractor.catch(() => (extractor = null));
  const fe = await extractor;
  const out = await fe([QUERY_PREFIX + text], { pooling: "cls", normalize: true });
  return out.data.subarray(0, out.dims[1]);
}

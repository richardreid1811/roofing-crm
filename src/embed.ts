// Query embedder for semantic permit search. Must match the pipeline's document embeddings:
// bge-small-en-v1.5, q8, CLS pooling, normalized, BGE query instruction. transformers.js loads from
// jsDelivr at a pinned version (its WASM runtime is too large to ship as a static asset).
import { withTimeout } from "../shared/timeout";

const TRANSFORMERS_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1/dist/transformers.min.js";
const MODEL = "Xenova/bge-small-en-v1.5";
const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";

type Extractor = (
  input: string[],
  opts: { pooling: "cls"; normalize: boolean },
) => Promise<{ data: Float32Array; dims: number[] }>;
let extractor: Promise<Extractor> | null = null;
// The library and model (~35 MB) come from CDNs; a stalled download must not hold the assistant forever.
export const EMBED_LOAD_TIMEOUT_MS = 90_000;

export async function embedQuery(text: string): Promise<Float32Array> {
  if (!extractor) {
    const loading = withTimeout(
      import(/* @vite-ignore */ TRANSFORMERS_URL).then(
        (lib: { pipeline: (task: string, model: string, opts: { dtype: string }) => Promise<Extractor> }) =>
          lib.pipeline("feature-extraction", MODEL, { dtype: "q8" }),
      ),
      EMBED_LOAD_TIMEOUT_MS,
      "Loading the semantic search model",
    );
    // A failed or timed-out load (network, CDN) is not cached, so the next search tries again.
    loading.catch(() => extractor === loading && (extractor = null));
    extractor = loading;
  }
  const fe = await extractor;
  const out = await fe([QUERY_PREFIX + text], { pooling: "cls", normalize: true });
  return out.data.subarray(0, out.dims[1]);
}

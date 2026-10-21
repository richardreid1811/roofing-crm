// Bounded waits for steps that can otherwise hang forever (a stalled IPFS gateway or a DuckDB-WASM
// worker that never answers). The step itself is not cancelled; the caller tears it down on retry.

export class TimeoutError extends Error {
  readonly step: string;
  readonly ms: number;
  constructor(step: string, ms: number) {
    super(`${step} timed out after ${Math.round(ms / 1000)} s`);
    this.name = "TimeoutError";
    this.step = step;
    this.ms = ms;
  }
}

/** Resolves or rejects like `work`, or rejects with a TimeoutError naming `step` after `ms`. */
export function withTimeout<T>(work: Promise<T>, ms: number, step: string): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>; // assigned synchronously by the executor below
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(step, ms)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

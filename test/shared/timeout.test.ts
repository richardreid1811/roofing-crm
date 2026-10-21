import { afterEach, describe, expect, it, vi } from "vitest";
import { TimeoutError, withTimeout } from "../../shared/timeout";

afterEach(() => {
  vi.useRealTimers();
});

describe("withTimeout", () => {
  it("passes through a result that arrives in time", async () => {
    await expect(withTimeout(Promise.resolve(42), 1000, "Loading the leads table")).resolves.toBe(42);
  });

  it("passes through the step's own error", async () => {
    await expect(withTimeout(Promise.reject(new Error("gateway 502")), 1000, "x")).rejects.toThrow("gateway 502");
  });

  it("rejects a step that never settles with a reason naming the step", async () => {
    vi.useFakeTimers();
    const hung = withTimeout(new Promise<never>(() => {}), 60_000, "Loading the leads table from IPFS");
    const outcome = expect(hung).rejects.toThrow("Loading the leads table from IPFS timed out after 60 s");
    await vi.advanceTimersByTimeAsync(59_999);
    await vi.advanceTimersByTimeAsync(1);
    await outcome;
    await expect(hung).rejects.toBeInstanceOf(TimeoutError);
  });

  it("does not fire before the deadline and clears its timer once settled", async () => {
    vi.useFakeTimers();
    let settled = false;
    const slow = withTimeout(
      new Promise<string>((resolve) => setTimeout(() => resolve("ok"), 30_000)),
      60_000,
      "Starting the in-browser database",
    ).then((v) => ((settled = true), v));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(settled).toBe(true);
    await expect(slow).resolves.toBe("ok");
    expect(vi.getTimerCount()).toBe(0);
  });
});

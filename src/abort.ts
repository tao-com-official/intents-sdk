import { AbortedError } from "./errors";

export function throwIfAborted(signal?: AbortSignal, txHash?: `0x${string}`): void {
  if (signal?.aborted) throw new AbortedError(undefined, txHash);
}

/**
 * Reject with `AbortedError` as soon as `signal` aborts. The underlying operation can't be cancelled
 * (a wallet prompt stays open, a sent transaction stays sent), we just stop waiting for it.
 * Pass `txHash` once a transaction is in flight so the caller can still recover the order from it.
 */
export function abortable<T>(promise: Promise<T>, signal?: AbortSignal, txHash?: `0x${string}`): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    promise.catch(() => {});
    return Promise.reject(new AbortedError(undefined, txHash));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new AbortedError(undefined, txHash));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

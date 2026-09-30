/**
 * Teaching exhibit (the `graphql` topic's N+1/batching section): the dataloader
 * pattern sketched by hand — the ~15-line core of what the `dataloader` package
 * generalizes (caching, error propagation, scheduling polish).
 *
 * The app's own resolvers do not need it: `posts` resolves the whole list in
 * one use-case call and Post's fields are default property reads, so there is
 * no per-entity fetching to multiply. N+1 arrives the moment a nested field
 * gains its own resolver that touches storage — which is when you reach for
 * this shape: load() returns a promise, and every promise requested in the
 * same tick is batched into ONE call to the batch function.
 *
 * One instance PER REQUEST (park it in contextValue), never a module
 * singleton — a shared loader leaks one user's cached data into another's.
 */
export class Loader<K, V> {
  private queue: { key: K; resolve: (v: V) => void; reject: (e: unknown) => void }[] = [];
  private scheduled = false;

  constructor(private readonly batchFn: (keys: readonly K[]) => Promise<V[]>) {}

  load(key: K): Promise<V> {
    return new Promise((resolve, reject) => {
      this.queue.push({ key, resolve, reject });
      if (!this.scheduled) {
        // microtask boundary: collect everything this tick asked for, then flush
        this.scheduled = true;
        queueMicrotask(() => void this.flush());
      }
    });
  }

  private async flush(): Promise<void> {
    const batch = this.queue; // everything the resolvers asked for…
    this.queue = [];
    this.scheduled = false;
    const values = await this.batchFn(batch.map((entry) => entry.key)); // …ONE query
    batch.forEach((entry, index) => entry.resolve(values[index]!));
  }
}

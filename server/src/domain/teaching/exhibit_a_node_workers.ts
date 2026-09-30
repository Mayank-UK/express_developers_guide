/**
 * Teaching exhibit (the `node-js` topic's workers-and-cluster section): the two
 * shapes for closing the single-threaded gap — worker_threads for CPU-bound
 * work off the event loop, cluster for N server processes on one port.
 *
 * Deliberately NOT executed anywhere: this guide's server runs one process,
 * one thread, on purpose (a legible teaching server over a local sqlite file
 * with a single writer — see the topic's "this guide" section). The exhibit
 * exists so the topic quotes real, compilable code instead of a hand-typed
 * sketch; the shapes are the ones production Node services run.
 */
import os from 'node:os';
import cluster from 'node:cluster';
import { Worker } from 'node:worker_threads';

/** Shape 1 — cluster: one full server process per core, all on the same port. */
export function runClustered(serverBootstrap: () => void): void {
  if (cluster.isPrimary) {
    for (const _core of os.cpus()) cluster.fork(); // each child runs this same file
  } else {
    serverBootstrap(); // child process: start the Express server — connections are shared out
  }
}

/**
 * Shape 2 — worker_threads: heavy CPU off the event loop, in-process. Real OS
 * threads with their own V8 isolate, communicating by message-passing.
 */
export function offloadToWorker(workerUrl: URL, input: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl, { workerData: { input } });
    worker.on('message', (result) => resolve(result)); // the loop stayed free the whole time
    worker.on('error', reject);
  });
}

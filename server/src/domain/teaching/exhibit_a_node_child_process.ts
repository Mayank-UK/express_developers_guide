/**
 * Teaching exhibit (the `node-js` topic's child-process section): the three
 * child_process shapes that sit BESIDE worker_threads and cluster —
 * execFile/exec for running a program and capturing its output, spawn for
 * streaming a program's output, fork for a Node child with a message channel.
 *
 * Deliberately NOT executed anywhere, same stance as exhibit_a_node_workers:
 * this guide's server runs one process by design, and no real child-process
 * call site exists in the repo (the security topic quotes exec vs execFile
 * from its injection catalog — a display string, not running code). The
 * exhibit exists so the topic quotes real, compilable code instead of a
 * hand-typed sketch; the shapes are the ones production services run.
 *
 * The rule the shapes share: exec/execFile BUFFER the child's output into
 * memory (bounded by maxBuffer) and hand it back once, when the child exits;
 * spawn STREAMS it (the child's stdout is a Readable — pipe it, don't buffer
 * it); fork is spawn specialized for Node→Node with the IPC channel wired in
 * (cluster.fork is fork under the hood).
 */
import {
  execFile,
  fork,
  spawn,
  type ChildProcess,
  type Serializable,
} from 'node:child_process';
import { Readable } from 'node:stream';

/**
 * Shape 1 — execFile: run a program, capture stdout/stderr, get one result.
 * The arguments travel as an argv array with NO shell involved (exec() is the
 * shell-string variant — the security topic's command-injection lesson).
 * The two options production code always wants: a deadline, and a deliberate
 * cap on captured output (exec/execFile buffer the whole thing in memory).
 */
export function captureToolOutput(
  command: string,
  args: readonly string[],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      { timeout: 5_000, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error !== null) reject(error); // spawn failure, non-zero exit, or timeout
        else resolve({ stdout, stderr });
      },
    );
  });
}

/**
 * Shape 2 — spawn: the same program, but output arrives as STREAMS. When a
 * child can produce more than belongs in memory (a database dump, a log
 * scan), do not buffer it — the child's stdout is a Readable; pipe it onward.
 */
export function spawnToolStream(command: string, args: readonly string[]): Readable {
  const child = spawn(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  return child.stdout!; // 'pipe' stdio guarantees this stream exists
}

/**
 * Shape 3 — fork: a Node module as a child process, with a message channel
 * pre-wired. Messages must be JSON-serializable values (and on the receiving
 * side, a child's 'message' handler mirrors this send). This is the channel
 * cluster's primary uses to supervise its workers.
 */
export function forkNodeModule(modulePath: string, job: Serializable): ChildProcess {
  const child = fork(modulePath);
  child.send(job); // rides the built-in IPC channel, not a socket you own
  return child;
}

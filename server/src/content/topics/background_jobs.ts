import type { Topic } from '../types.js';

/**
 * The Background Jobs topic: the guide's "work that outlives the request"
 * story. The queue under /api/demo/jobs (domain/jobs/job_queue.ts) is
 * hand-rolled on purpose — the queue itself is the lesson — and every code
 * block below is its real running source. Demos drive the real endpoints.
 */
export const topicBackgroundJobs: Topic = {
  id: 'background-jobs',
  title: 'Background Jobs',
  subtitle:
    'Queues, schedulers, retries, and dead-letter handling for work that outlives the request.',
  group: 'realtime-jobs',
  order: 2,
  sections: [
    {
      id: 'jobs-why',
      title: 'Why work moves to the background',
      lead:
        'Some work a request triggers is not work the request should WAIT for. Drawing that line — request, execute, acknowledge — is the whole discipline.',
      blocks: [
        {
          kind: 'text',
          id: 'jobs-why:latency-and-isolation',
          body: `THE LINE, drawn by three questions. (1) DOES THE USER NEED THE ANSWER? Rendering a product page needs the product's rows; it does NOT need the receipt email sent, the analytics event flushed, or the search index updated — those have no bytes in the response. Doing them inline means the user's page-load time now includes an SMTP handshake (hundreds of ms on a good day, 30s of timeouts on a bad one) — latency the user pays for work they cannot see. (2) WHAT IF IT FAILS? Inside a request, a failure after the response is "best effort" and a failure before it is a 500 the user stares at; either way the WORK is hostage to the request's lifetime. A background job retries INDEPENDENTLY of any request: the SMTP provider blips for two seconds, the job fails, the queue tries again in thirty — the user never knew. That is FAILURE ISOLATION, and it is worth more than the latency win: a queue converts "must succeed right now, inside this request" into "must succeed eventually, with a bounded number of tries." (3) WHAT IF THE SERVER DIES MID-WORK? A job tracked only in a request's memory dies with it; a job tracked in a queue is still there when the process comes back. THE REQUEST/EXECUTE/ACKNOWLEDGE SPLIT is the shape that falls out: the REQUEST validates and enqueues (fast, durable, returns 202-ish "accepted"), a WORKER executes later (with retries), and an ACKNOWLEDGE — a webhook, a status field, an email arriving — closes the loop asynchronously. This guide's demo keeps all three visible: POST /api/demo/jobs/enqueue is the request, the in-process worker is the executor, and the job board you can watch is the acknowledgement surface. WHAT BELONGS WHERE, the honest version: work that is SLOW (email, PDF rendering, video transcoding, calling a third-party API with a 30s timeout), work that is FLAKY-THROUGH-NO-FAULT-OF-YOURS (any network dependency), work that is BURSTY (a thousand uploads each needing a thumbnail — enqueue and drain at your own pace), and work that is SCHEDULED (nightly reports) goes to the queue. Work that is CHEAP AND NEEDED FOR THE RESPONSE stays inline — do not queue a write your response will immediately read back; you will spend the rest of the week reasoning about read-after-write. And work that must run WHETHER OR NOT ANYONE IS MAKING REQUESTS (cleanup, digest emails, certificate rotation) is a SCHEDULE, not a queue — the scheduler section takes that fork. The rule of thumb people actually use: if you are about to await something the user does not need, in a handler, with a timeout you picked by hoping — that is a job.`,
        },
        {
          kind: 'code',
          id: 'jobs-why:decision-table',
          language: 'text',
          caption: 'Where work goes — the four homes, and what earns each',
          code: `home            when                                              failure story                    clock
──────────────  ────────────────────────────────────────────────  ───────────────────────────────  ──────────────────
inline          the response needs the result (DB reads, auth)    500 now, user sees it           none
queue           slow / flaky / bursty work triggered by a request retries with backoff, dead-letters  run ASAP (+ retries)
schedule/cron   must run regardless of traffic (cleanup, digests)  missed runs are skipped/caught   every N / cron expr
fire-and-forget (without a queue)                                  lost on crash, unretryable      never do this on purpose`,
        },
      ],
    },
    {
      id: 'jobs-anatomy',
      title: 'Anatomy of a job queue',
      lead:
        'Five nouns and one loop. This guide builds the queue by hand — no Redis, no BullMQ — because at this size the concepts are load-bearing and a library would only hide them.',
      blocks: [
        {
          kind: 'text',
          id: 'jobs-anatomy:parts',
          body: `THE FIVE NOUNS. A JOB is a durable record of work-to-do: an id (job_1, job_2…), a TYPE (the verb: send-email, build-report), and a PAYLOAD (the noun: addresses, parameters) — plus the bookkeeping the queue adds: status, attempt count, runAt, history. An ENQUEUE is the act of appending a job (validation happens HERE — a malformed job must be refused before it enters the queue, exactly like a malformed request at the API edge; the guide's enqueue returns the same Result/Failure the use cases return). A WORKER is the loop that takes due jobs and runs them. An ATTEMPT is one execution of a job, paired with a BACKOFF — the wait before the next try. A DEAD-LETTER QUEUE is where jobs that exhausted their attempts park, visible and replayable instead of silently gone. DELIVERY SEMANTICS, the price tag everyone skips: an in-memory queue like this one gives you AT-MOST-ONCE across process crashes (kill -9 loses the queued jobs — the realtime topic hit the same ceiling with its socket registry); a durable queue (jobs persisted in Postgres/Redis/Mongo, or a real broker) gives you AT-LEAST-ONCE — the job WILL run, but "at least" is doing honest work: a worker can crash AFTER sending the email but BEFORE recording the success, so the retry sends it twice. The contract you must therefore write every handler against is IDEMPOTENCY: running twice must be as safe as running once. Sending "your order shipped" twice is survivable; charging a card twice is not (that is why payment flows carry idempotency keys — the API design topic met them as header conventions; here they are the same idea on YOUR side of the wire). THE WORKER LOOP below is deliberately CONCURRENCY 1: one job at a time, because serial makes the demo's state machine honest and the teaching unambiguous — but say the real-world part out loud: production workers run pools (concurrency 10, 50) with per-resource limits, because one slow SMTP hop must not stall nine healthy jobs behind it. Concurrency buys throughput and costs you ordering and idempotency pressure — the same trade every queue makes. BUILD VS BUY, since the catalog is fair: BullMQ (Redis-backed, the current standard for Node), Bull (its predecessor, legacy), and Agenda (Mongo-backed, cron-flavored) all give you exactly these five nouns plus durability, dashboards, and rate limiting. Reach for one the moment jobs must survive restarts or volume gets real — and note that "Redis-backed" means the Redis topic's connection discipline (lazy singleton, dedicated subscriber) is the SAME plumbing a Redis-backed queue sits on; this guide keeps the queue in-process so the lesson has zero moving parts you have not already met.`,
        },
        {
          kind: 'code',
          id: 'jobs-anatomy:verbatim-enqueue',
          language: 'ts',
          source: 'server/src/domain/jobs/job_queue.ts',
          caption: 'Verbatim — enqueue: validate, mint, and wake the loop (domain/jobs/job_queue.ts)',
          code: `/**
 * Enqueue a job: validate type + payload, mint \`job_<seq>\`, and wake the
 * worker loop. Returns a Result — the domain never throws for expected
 * failures; the route edge maps this onto the 400 envelope.
 */
enqueue(type: string, payload: unknown): Result<Job, Failure> {
  if (!JOB_TYPES.includes(type as JobType)) {
    return fail(
      failure('validation', \`"type" must be one of the known job types (got "\${String(type)}")\`, {
        parameter: 'type',
        supported: [...JOB_TYPES],
      }),
    );
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return fail(
      failure('validation', '"payload" must be a JSON object', {
        parameter: 'payload',
        received: Array.isArray(payload) ? 'array' : typeof payload,
      }),
    );
  }

  const nowMs = this.now();
  const at = this.isoFromMs(nowMs);
  const job: Job = {
    id: \`job_\${(this.nextSeq += 1)}\`,
    type: type as JobType,
    payload: { ...(payload as Record<string, unknown>) },
    status: 'queued',
    attempts: 0,
    history: [{ at, event: 'enqueued' }],
    createdAt: at,
    runAt: at,          // due immediately — a retry pushes this into the future
  };
  this.jobs.set(job.id, { job, createdAtMs: nowMs, runAtMs: nowMs });
  this.totalEnqueued += 1;
  this.scheduleDrain(0);
  return ok(job);
}`,
        },
        {
          kind: 'code',
          id: 'jobs-anatomy:verbatim-drain',
          language: 'ts',
          source: 'server/src/domain/jobs/job_queue.ts',
          caption: 'Verbatim — the worker: one due job at a time, outcome applied, keep draining',
          code: `/**
 * One drain pass: take the FIRST queued job whose runAt has arrived (FIFO
 * among due jobs), run it, apply the outcome, and keep draining. Work is
 * strictly serial — \`processing\` is the lock — which keeps the demo's state
 * machine honest; real workers go concurrent with a pool (and pay for it
 * with per-resource rate limits, see the content).
 */
private async drainTick(): Promise<void> {
  if (this.processing) return;

  const due = [...this.jobs.values()].find(
    (record) => record.job.status === 'queued' && record.runAtMs <= this.now(),
  );
  if (due === undefined) {
    // Nothing due — re-arm for the earliest future runAt (or run out of work).
    const nextRunAtMs = [...this.jobs.values()]
      .filter((record) => record.job.status === 'queued')
      .map((record) => record.runAtMs)
      .sort((a, b) => a - b)[0];
    if (nextRunAtMs !== undefined) this.scheduleDrain(nextRunAtMs - this.now());
    return;
  }

  // The concurrency-1 lock must be exception-safe: handlers report EXPECTED
  // failures as Results, but a handler BUG throws — and without a finally
  // that throw would strand processing at true, so every later drainTick
  // would no-op at the guard and the queue would silently halt. (The
  // outcome block inside the try is synchronous, so holding the lock
  // across it changes nothing.)
  this.processing = true;
  try {
    const { job } = due;
    job.status = 'running';
    job.history.push({ at: this.isoNow(), event: 'running', attempt: job.attempts + 1 });

    const outcome = await this.runHandler(job);

    if (outcome.ok) {
      job.status = 'succeeded';
      job.result = outcome.result;
      job.history.push({ at: this.isoNow(), event: 'succeeded', attempt: job.attempts + 1 });
    } else {
      job.attempts += 1;
      job.lastError = outcome.error;
      if (job.attempts < this.maxAttempts) {
        const delayMs = this.backoffDelayMs(job.attempts);
        const runAtMs = this.now() + delayMs;
        job.status = 'queued';
        due.runAtMs = runAtMs;
        job.runAt = this.isoFromMs(runAtMs);
        job.history.push({
          at: this.isoNow(),
          event: 'retry_scheduled',
          attempt: job.attempts,
          delayMs,
        });
      } else {
        job.status = 'dead';
        job.history.push({
          at: this.isoNow(),
          event: 'dead_lettered',
          attempt: job.attempts,
          lastError: outcome.error,
        });
      }
    }
  } finally {
    this.processing = false;
  }

  this.scheduleDrain(0); // keep draining — there may be more work behind this one
}

/** Sleep through the INJECTED timer so fake-clock tests stay deterministic. */
private sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    this.setTimeoutFn(() => resolve(), ms);
  });
}`,
        },
        {
          kind: 'text',
          id: 'jobs-anatomy:injectable-time',
          body: `TIME IS A DEPENDENCY, and this queue injects it. The constructor takes \`now\`, \`setTimeoutFn\`, and \`clearTimeoutFn\` — the same discipline the i18n topic applied to formatting instants — and the payoff is the same: the specs drive a FAKE CLOCK deterministically (advance(ms) fires every due timer in order, letting async continuations register their follow-ups between firings) instead of sleeping real seconds and hoping. "Retry after ~300ms then ~600ms ± 20%" is ASSERTED, not observed once. The demo defaults are honest about being demo defaults: baseDelayMs 300 makes a full retry cycle watchable in about a second; production backoff is seconds-scale (a realistic base is 1000 — 1s, 2s, 4s with jitter — and for external SMTP, minutes) and the CODE IS IDENTICAL; only the constant changes. The tests you would actually write for a real queue are exactly these: mechanics under a fake clock (fast, deterministic, every branch), plus one real-timer integration case with generous budgets (the scheduler ticking, a serial worker provably serial) — because injected time proves the logic, but only real time proves the plumbing.`,
        },
      ],
    },
    {
      id: 'jobs-retries',
      title: 'Retries and backoff',
      lead:
        'A retry is a bet that the failure was transient. Backoff spaces the bets out; a max caps the losses; classifying the error decides whether to bet at all.',
      blocks: [
        {
          kind: 'text',
          id: 'jobs-retries:backoff-and-jitter',
          body: `EXPONENTIAL BACKOFF is the standard spacing: attempt n waits base × 2^(n-1) — with a 300ms base that is ~300ms, then ~600ms, then (if you allowed a fourth try) ~1200ms; with the realistic 1000ms base it is 1s, 2s, 4s. The doubling is a courtesy to whatever is failing: if the SMTP provider is down, hammering it every 50ms is how you turn its recovery into its next outage. Backoff without a CAP is also a bug — 2^10 of a one-second base is seventeen minutes, 2^20 is twelve days, so real queues cap the delay (BullMQ calls it exponential.cap; this guide's three attempts never get far enough to need one, and the content is where the honesty lives). JITTER — randomizing each delay by ±20% — looks cosmetic and is not: without it, every job that failed during the same incident retries IN LOCKSTEP, and a dependency recovering at t=300ms meets the full thundering herd of your retry queue at exactly t=300ms, fails again in unison, and re-herds at t=900ms. Jitter de-synchronizes the herd into a drizzle. (The reliability-patterns topic reuses this exact jittered-exponential shape for HTTP-level retries — one mental model, two altitudes.) MAX ATTEMPTS bounds the story: this queue does three (DEMO_MAX_ATTEMPTS = 3), and the attempt counter on the job board reads attempts/max — 2/3 means two failures consumed, one try left. WHY A MAX AT ALL — because infinite retry is not persistence, it is denial-of-service against yourself: a job that can never succeed will retry forever, consuming worker capacity and log volume, UNLESS something stops it. That something is the dead-letter transition (next section). THE RETRYABLE-VERSUS-FATAL DISTINCTION is where hand-rolled queues earn their keep: NOT EVERY ERROR DESERVES A RETRY. A 500/503/timeout from a dependency is transient — bet again. A 400 "invalid recipient", a validation failure, a missing template is PERMANENT — the job is asking for something that will never work, and retrying it just re-runs the garbage three times before dead-lettering it (with email, some providers will even throttle-block you for it). The guide's own taxonomy is the classifier: a Failure of kind validation/unauthorized/not_found is fatal, kinds unavailable/internal are retryable — a distinction the handlers should apply BEFORE burning attempts (this demo's handlers are simple enough that every failure retries, which keeps the lifecycle watchable; the classification rule is stated here so you know where it goes). The email handler's injection knobs exist precisely to make the retry ladder VISIBLE: forceFailures: 2 fails the first two attempts on purpose (watch the job go queued → running → queued → running → queued → running → succeeded, each retry_scheduled entry carrying its delayMs), and alwaysFail refuses to ever succeed — the ladder's tragic version, ending in the dead-letter.`,
        },
        {
          kind: 'code',
          id: 'jobs-retries:verbatim-backoff',
          language: 'ts',
          source: 'server/src/domain/jobs/job_queue.ts',
          caption: 'Verbatim — exponential backoff WITH jitter, and where it is applied',
          code: `/**
 * Exponential backoff WITH jitter: attempt n waits base × 2^(n-1), ±20%.
 * The jitter is not decoration — without it every failed job in a burst
 * retries in lockstep and the dependency they all share gets thundering-herded.
 */
private backoffDelayMs(attempt: number): number {
  const raw = this.baseDelayMs * 2 ** (attempt - 1);
  const jitter = raw * JITTER_FRACTION * (Math.random() * 2 - 1);
  return Math.max(1, Math.round(raw + jitter));
}

// applied inside drainTick's failure branch:
//   job.attempts += 1;
//   job.lastError = outcome.error;
//   if (job.attempts < this.maxAttempts) {
//     const delayMs = this.backoffDelayMs(job.attempts);
//     ...runAt = now + delayMs;  history + { event: 'retry_scheduled', attempt, delayMs }
//   } else {
//     ...status = 'dead';        history + { event: 'dead_lettered', attempt, lastError }
//   }
//
// The demo base is 300ms so the ladder is watchable: retries land at ~300ms
// and ~600ms (± 20%). Real-world base is seconds — 1000 gives 1s / 2s / 4s.`,
        },
      ],
    },
    {
      id: 'jobs-dead-letter',
      title: 'Dead-letter and replay',
      lead:
        'Every queue needs a place for work that will not succeed — and an alarm on that place, because a dead-letter queue nobody watches is just a slower crash.',
      blocks: [
        {
          kind: 'text',
          id: 'jobs-dead-letter:parking-lot',
          body: `THE PARKING LOT. When a job exhausts maxAttempts it becomes DEAD — status dead, history ending in a dead_lettered entry carrying the lastError, and (this is the point) STILL THERE. The naive alternative — drop it, log it, move on — fails silently forever: a bug in an email template means every signup that hit it never got a welcome email, nobody notices, and the queue reports "healthy" because it is EMPTY. The dead-letter state converts invisible loss into a visible pile. A DLQ IS ONLY USEFUL IF SOMEBODY LOOKS AT IT — the operational rule this guide teaches with its own stats endpoint: ALERT WHEN THE PILE GROWS. Depth of the dead counter above zero, or its age above a minute, pages someone; the observability section wires the two numbers that matter. (In production this is a dashboard panel plus a pager rule; the mechanics are identical — count, age, threshold.) POISON MESSAGES are the DLQ's regulars: a payload that can never succeed — the demo's alwaysFail email is a deliberate one. They matter because they are SELF-REPLICATING in a specific boring way: a bug in a template renders every job using that template into a poison message; you fix the bug; NOW the pile is replayable. Which is the entire argument for REPLAY TOOLING: requeueing a dead job must be one deliberate action (this queue: POST /api/demo/jobs/:id/requeue, and the demo board's REQUEUE button), it must give the job a FRESH retry BUDGET (attempts reset — the fixed code gets three real tries, not the zero that were left), and it must KEEP THE HISTORY (the postmortem of what went wrong survives the replay — a queue that forgets on requeue trains operators to screenshot before clicking). TWO GUARDS, because replay is a loaded gun: only DEAD jobs can be requeued (requeueing a succeeded job is exactly how duplicate emails happen — the endpoint answers 400 with that reasoning in its details), and replay after a fix should be BOUNDED — requeue a thousand poison messages at once and you have re-created the herd the jitter just saved you from; real tooling trickles (BullMQ's retry jobs per tick). Note what requeue does NOT do here: change the payload. Editing the job before replay is the next step up in tooling (and the point where you want an audit log of who changed what, because "we edited the payload then re-sent the email" is a sentence compliance teams enjoy hearing with timestamps).`,
        },
        {
          kind: 'code',
          id: 'jobs-dead-letter:verbatim-requeue',
          language: 'ts',
          source: 'server/src/domain/jobs/job_queue.ts',
          caption: 'Verbatim — requeue: fresh budget, kept history, dead-only guard (domain/jobs/job_queue.ts)',
          code: `/**
 * Replay a dead-lettered job: attempts reset (it gets a fresh retry
 * budget), history is KEPT (the postmortem survives the replay). Only dead
 * jobs qualify — requeueing a succeeded job is how duplicate emails happen.
 */
requeue(id: string): Result<Job, Failure> {
  const record = this.jobs.get(id);
  if (record === undefined) {
    return fail(failure('not_found', \`no job with id "\${id}"\`, { jobId: id }));
  }
  if (record.job.status !== 'dead') {
    return fail(
      failure('validation', \`only dead-lettered jobs can be requeued (job is "\${record.job.status}")\`, {
        jobId: id,
        status: record.job.status,
        hint: 'a succeeded job already ran — requeueing it would duplicate its side effect',
      }),
    );
  }
  const nowMs = this.now();
  record.job.status = 'queued';
  record.job.attempts = 0;              // fresh retry budget…
  record.runAtMs = nowMs;
  record.job.runAt = this.isoFromMs(nowMs);
  record.job.history.push({ at: record.job.runAt, event: 'requeued' }); // …postmortem kept
  this.scheduleDrain(0);
  return ok(record.job);
}

// the route edge (routes/jobs_demo_routes.ts) — the 400 envelope carries the
// WHY, not just the no:
// function requeueController(req: Request, res: Response): void {
//   const result = getDemoJobQueue().requeue(String(req.params.id));
//   if (!result.ok) throw failureToException(result.error);
//   res.json({ job: result.value });
// }`,
        },
      ],
    },
    {
      id: 'jobs-schedules',
      title: 'Schedules and cron',
      lead:
        'Queues react; schedules initiate. The same queue, driven by a clock instead of a request — plus the multi-node question that clock immediately raises.',
      blocks: [
        {
          kind: 'text',
          id: 'jobs-schedules:policy',
          body: `TWO WAYS TO SAY WHEN. An INTERVAL ("every 5s") is simple and drifts — each tick lands interval after the previous one ENDS, so a 5-minute job on a 5-minute interval actually runs every ten. A CRON EXPRESSION ("0 3 * * *" — 03:00 daily) is the industry default: human-readable slots, timezone-fraught (03:00 local WHERE? spring-forward skips a run, fall-back runs it twice — schedule in UTC and say so out loud), and what every ops team already has tooling to reason about. The mature pattern uses both: the SCHEDULER is dumb and cron-shaped, and its only job is to ENQUEUE — "at 03:00, enqueue build-daily-report" — so the report itself gets the queue's retries, backoff, and dead-lettering. A scheduler that RUNS work directly is a queue with none of the safety net. THE MISSED-RUN POLICY is a decision, not an accident: SKIP (the default, and usually right — two cleanup runs back to back is wasted work) versus CATCH-UP (run it N times fast, or once with a flag saying it is late — right when the run is a SYNCHRONIZATION, like an incremental export: skipping means the gap never closes). You are choosing when you choose your library's defaults, so choose on purpose. THE MULTI-NODE PROBLEM is the reason schedulers get their own section: setInterval in ONE process is correct HERE — this guide runs one node, and the scheduler's ticks enqueue into the same in-process queue (tick counters visible on the board, source: 'scheduler'). Run TWO nodes with the same code and every scheduled job fires TWICE — the nodes do not know about each other. The scale story, in order of weight: a SINGLE-WRITER lock in the database the nodes share (a row claimed with a conditional UPDATE — boring, works, most teams' answer), a DEDICATED scheduler deployment (one pod whose only job is ticking — moves the problem to "who guarantees one pod", i.e. your orchestrator), or the queue's own tooling (BullMQ's repeatable jobs / Redis sorted sets put the schedule where the work already lives — the Redis topic's structures are literally this). The demo's setScheduler(running, intervalMs) has SET SEMANTICS by construction — every call bumps a generation counter, so a pending tick from an older configuration fires into a guard and dies — which makes the toggle idempotent: on/off/on leaves exactly ONE chain of ticks, never a stack. That guard is the kind of detail specs exist to hunt (the domain spec drives on → replace → on and counts the exact ticks). Interval bounds are clamped (1000–60000ms through the HTTP surface) for the same reason the SSE ticker clamps: a client-facing cadence knob without a floor is a self-DoS button.`,
        },
        {
          kind: 'code',
          id: 'jobs-schedules:verbatim-scheduler',
          language: 'ts',
          source: 'server/src/domain/jobs/job_queue.ts',
          caption: 'Verbatim — the scheduler: set semantics via a generation guard (job_queue.ts)',
          code: `/**
 * Turn the cron-ish scheduler on/off. SET semantics: exactly one chain of
 * ticks ever runs — every call bumps the generation, so a pending tick from
 * an older configuration fires into a guard and dies instead of stacking a
 * second interval (the classic setScheduler bug the specs hunt for).
 */
setScheduler(running: boolean, intervalMs: number = DEMO_SCHEDULER_INTERVAL_MS): SchedulerState {
  this.schedulerGeneration += 1;
  if (this.schedulerTimer !== undefined) {
    this.clearTimeoutFn(this.schedulerTimer);
    this.schedulerTimer = undefined;
  }
  this.schedulerRunning = running;
  if (running) {
    this.schedulerIntervalMs = clamp(
      intervalMs,
      SCHEDULER_INTERVAL_MS_MIN,
      SCHEDULER_INTERVAL_MS_MAX,
    );
    this.armSchedulerTick(this.schedulerIntervalMs);
  }
  return this.schedulerState();
}

private armSchedulerTick(delayMs: number): void {
  const generation = this.schedulerGeneration;
  this.schedulerTimer = this.setTimeoutFn(() => {
    if (generation !== this.schedulerGeneration) return; // replaced/off — this chain is dead
    this.schedulerTimer = undefined;
    this.schedulerTick += 1;
    this.schedulerLastRunAt = this.isoNow();
    this.enqueue('report', { source: 'scheduler', tick: this.schedulerTick }); // enqueue, don't run
    this.armSchedulerTick(this.schedulerIntervalMs);                             // re-chain
  }, Math.max(0, delayMs));
}`,
        },
      ],
    },
    {
      id: 'jobs-email',
      title: 'Email as the canonical job',
      lead:
        'External, slow, flaky, and utterly irrelevant to the response that triggered it — email is the workload queues were invented for, and this guide\'s teaching workload.',
      blocks: [
        {
          kind: 'text',
          id: 'jobs-email:why',
          body: `WHY EMAIL, specifically: it hits every axis at once. EXTERNAL — an SMTP provider or API on the far side of a network you do not control, so failure is weather, not bug. SLOW — a handshake, a queue on THEIR side, a delivery attempt to the recipient's MX; hundreds of milliseconds minimum, seconds commonly, and a timeout budget you must set while hoping. FLAKY-THROUGH-NO-FAULT-OF-YOURS — providers throttle, greylist your first send to a new domain (deliberately, to see if you are a spammer), and rate-limit per tenant. USER-IRRELEVANT LATENCY — the signup response needs "account created", not "email delivered"; the email arriving thirty seconds later is a perfectly good email. Swap in "SMS", "push notification", "invoice PDF", "third-party enrichment call" — the shape is identical, which is why every queue tutorial since the dawn of time uses email, and why this one does too, honestly. THE SIMULATED SENDER: this guide's email handler does not open a socket — it awaits a randomized 80–200ms latency (to feel like the real thing) and then succeeds or fails by PAYLOAD CONTRACT: alwaysFail: true never succeeds (the poison message), forceFailures: n fails the first n attempts (the retry ladder made watchable), latencyMs pins the latency (demos and the serial-worker proof). Every result carries simulated: true so no output can be mistaken for a sent email. The failure injection is not a toy: it is the ONLY way to make retries, backoff, and dead-lettering demonstrable on demand, in a test, in CI — a real provider failing on cue is not a thing you can schedule. A REAL TRANSPORT lands with the third-party services section (nodemailer against a sandbox) — and this is the design payoff: because the handler returns an outcome and the QUEUE owns the lifecycle, swapping the simulated sender for a real one changes ONE function. No retry logic moves. No route changes. The queue never learns what email is. That seam — handler returns {ok} or {error}, queue decides what to do about it — is the entire architecture lesson of this topic.`,
        },
        {
          kind: 'code',
          id: 'jobs-email:verbatim-handler',
          language: 'ts',
          source: 'server/src/domain/jobs/job_queue.ts',
          caption: 'Verbatim — the simulated sender: latency, injection knobs, honest result (job_queue.ts)',
          code: `/**
 * The SIMULATED sender: a random 80–200ms latency to feel like an SMTP hop,
 * plus failure injection knobs so retries and dead-lettering are watchable:
 * - alwaysFail: true        → never succeeds (a poison message)
 * - forceFailures: n        → fails the first n attempts, then succeeds
 * - latencyMs: number       → fixed latency override (demos + the serial-worker proof)
 * A REAL transport (nodemailer) lands with the third-party services section;
 * the queue's contract stays exactly this shape.
 */
private async simulatedEmailSender(job: Job): Promise<HandlerOutcome> {
  const payload = job.payload;
  const latencyMs =
    typeof payload.latencyMs === 'number' && Number.isFinite(payload.latencyMs)
      ? clamp(payload.latencyMs, 10, 2000)
      : EMAIL_LATENCY_MIN_MS + Math.random() * (EMAIL_LATENCY_MAX_MS - EMAIL_LATENCY_MIN_MS);
  await this.sleep(latencyMs);

  if (payload.alwaysFail === true) {
    return { ok: false, error: 'simulated sender: alwaysFail requested — this job can never succeed' };
  }
  const forceFailures =
    typeof payload.forceFailures === 'number' && Number.isFinite(payload.forceFailures)
      ? Math.max(0, Math.floor(payload.forceFailures))
      : 0;
  if (forceFailures > job.attempts) {
    return {
      ok: false,
      error: \`simulated sender: injected failure \${String(job.attempts + 1)} of \${String(forceFailures)}\`,
    };
  }
  return {
    ok: true,
    result: {
      to: typeof payload.to === 'string' && payload.to !== '' ? payload.to : 'student@example.com',
      subject:
        typeof payload.subject === 'string' && payload.subject !== ''
          ? payload.subject
          : 'Welcome',
      simulated: true,
      latencyMs,
    },
  };
}

// The report handler is the queue's "slow but reliable" twin — and an honesty
// note: its row count comes from a STATIC teaching fixture, not the posts
// pipeline, because wiring the container into the domain here would point the
// domain layer at the composition root (an inverted dependency) and couple
// this lesson to the fake/live data-mode toggle:
private async buildReport(_job: Job): Promise<HandlerOutcome> {
  await this.sleep(100);
  return { ok: true, result: { rows: TEACHING_REPORT_ROWS.length } };
}`,
        },
      ],
    },
    {
      id: 'jobs-observability',
      title: 'Observability: the two numbers that matter',
      lead:
        'A queue you cannot see is a liability with extra steps. Queue depth and oldest-job age are the pair that catch almost everything; everything else is diagnosis.',
      blocks: [
        {
          kind: 'text',
          id: 'jobs-observability:two-numbers',
          body: `DEPTH AND AGE. QUEUE DEPTH (how many jobs are waiting) is the throughput lie detector: depth near zero means consumers keep up; depth that climbs during traffic and drains after means you are absorbing bursts (the queue doing its job); depth that climbs and NEVER drains means consumers are outpaced or dead — every queue's outage looks like this first. OLDEST-JOB AGE (how long the eldest has been waiting) is depth's honest twin, because depth alone hides a stuck queue: one job that is never picked up reads as depth 1, forever, "basically empty" — while its age ticks toward infinity. Age is the number that pages. THE ALERTS, written as rules: page on age (oldest job older than X means work is stranding), page on depth-sustained (depth above Y for Z minutes means a drain, not a burst), page on DLQ GROWTH (the dead counter above zero — see the dead-letter section: a DLQ nobody watches is just a slower crash), and alert — not page — on the FAILURE RATE shifting (a retry-rate spike is the leading indicator of an upstream incident; a success-rate drop is the trailing confirmation). THIS QUEUE'S STATS ENDPOINT exposes exactly that board: per-status counts, totalEnqueued (lifetime volume), oldestQueuedAgeMs (null when idle — the honest reading), the scheduler's state, and a config echo (baseDelayMs, maxAttempts) so the dashboard never guesses which constants it is looking at. The client demo renders the strip live. Success and failure RATES are derivable from history volume over time — in production you would histogram them (the observability topic builds that pipeline: structured logs with request ids are already half of it); here the raw counters plus the history timeline per job are the honest teaching size. One more observability freebie this design gets on purpose: EVERY job carries its HISTORY — an append-only log of enqueued/running/retry_scheduled/dead_lettered/requeued events with timestamps and the actual delayMs of each backoff. That is a per-job distributed trace in miniature, it is what makes the demo's retry ladder WATCHABLE, and it is the artifact you will wish you had when someone asks "did the welcome email try to send?" — the answer is a GET, not an archaeology dig through logs.`,
        },
        {
          kind: 'code',
          id: 'jobs-observability:verbatim-stats',
          language: 'ts',
          source: 'server/src/domain/jobs/job_queue.ts',
          caption: 'Verbatim — the stats that make the queue observable (domain/jobs/job_queue.ts)',
          code: `/** The queue's counters — the two numbers that matter for alerts are here. */
stats(): JobQueueStats {
  let queued = 0;
  let running = 0;
  let succeeded = 0;
  let dead = 0;
  let oldestQueuedCreatedAtMs: number | undefined;
  for (const record of this.jobs.values()) {
    switch (record.job.status) {
      case 'queued':
        queued += 1;
        if (oldestQueuedCreatedAtMs === undefined || record.createdAtMs < oldestQueuedCreatedAtMs) {
          oldestQueuedCreatedAtMs = record.createdAtMs;
        }
        break;
      case 'running':
        running += 1;
        break;
      case 'succeeded':
        succeeded += 1;
        break;
      case 'dead':
        dead += 1;
        break;
    }
  }
  const nowMs = this.now();
  return {
    queued,
    running,
    succeeded,
    dead,
    totalEnqueued: this.totalEnqueued,
    oldestQueuedAgeMs:
      oldestQueuedCreatedAtMs === undefined ? null : Math.max(0, nowMs - oldestQueuedCreatedAtMs),
    scheduler: this.schedulerState(),
    config: { baseDelayMs: this.baseDelayMs, maxAttempts: this.maxAttempts },
  };
}

// GET /api/demo/jobs/stats serves it verbatim; the board poller in the demo
// renders: queued N · running N · succeeded N · dead N · oldest Xs`,
        },
      ],
    },
    {
      id: 'jobs-live',
      title: 'See it live (the watchable queue)',
      lead:
        'One demo over the real endpoints: enqueue emails with injected temperaments, watch them retry with visible backoff, dead-letter, replay — and flip the scheduler on.',
      blocks: [
        {
          kind: 'text',
          id: 'jobs-live:intro',
          body: `THE CONSOLE is the queue's whole lifecycle on one screen, polling GET /api/demo/jobs and /stats every second. Three ENQUEUE buttons cover the three temperaments: WELCOME (succeeds first try — the boring case that pays the bills), FLAKY (forceFailures: 2 — fails twice on purpose, then succeeds; its history timeline is the retry ladder with the actual backoff delays rendered, ~300ms then ~600ms ± jitter), and POISON (alwaysFail — rides the ladder all the way to the dead-letter). Each JOB CARD carries a status chip (queued, running, succeeded, dead — color-coded), the attempt counter (attempts/maxAttempts), and an expandable HISTORY TIMELINE: every event with its timestamp, and every retry_scheduled with its delayMs — the backoff curve as text. Dead cards grow a REQUEUE button: click it and watch the replayed job run the ladder again with a fresh budget, its old history intact below the requeued marker. THE SCHEDULER TOGGLE posts {running: true/false} — scheduler-enqueued report jobs appear on the board with a source badge and a tick number, so you can watch a cron feed a queue in real time. The STATS STRIP (queued/running/succeeded/dead + the oldest queued job's age) is the observability section made small — stare at it while enqueueing poison emails and you are doing queue operations. CLEAR resets the board and switches the scheduler off. The curl block does the same tour from a terminal — enqueue a flaky email, poll its history until the succeeded entry, meet the dead-letter, requeue it, and read the stats the alerting rules would consume.`,
        },
        {
          kind: 'demo',
          id: 'jobs-live:console-demo',
          demoId: 'jobs:console',
          title: 'The job console: watch work retry, die, and live again',
          description:
            'Real endpoints — enqueue welcome/flaky/poison emails and watch status chips walk queued → running → succeeded or dead, with the retry backoff delays rendered in each job\u2019s history timeline; dead jobs get a REQUEUE button; the scheduler toggle feeds report jobs onto the board with a source badge; the stats strip tracks depth and oldest-job age.',
        },
        {
          kind: 'code',
          id: 'jobs-live:curl',
          language: 'bash',
          caption: 'The background-jobs surface from a terminal — the full lifecycle in eight commands',
          code: `# 1. The boring case: a welcome email, default payload — succeeds on try 1:
curl -s -X POST localhost:4000/api/demo/jobs/enqueue \\
  -H 'content-type: application/json' -d '{"type":"email"}' | jq

# 2. The flaky case: forceFailures 2 → fails twice, then succeeds.
#    Poll its history and watch the retry ladder (delayMs ≈ 300, then 600 ± 20%):
JOB=$(curl -s -X POST localhost:4000/api/demo/jobs/enqueue \\
  -H 'content-type: application/json' \\
  -d '{"type":"email","payload":{"forceFailures":2,"latencyMs":60}}' | jq -r .job.id)
sleep 3 && curl -s localhost:4000/api/demo/jobs/$JOB | jq .job.history

# 3. The poison case: alwaysFail → three attempts, then dead_lettered:
POISON=$(curl -s -X POST localhost:4000/api/demo/jobs/enqueue \\
  -H 'content-type: application/json' \\
  -d '{"type":"email","payload":{"alwaysFail":true,"latencyMs":40}}' | jq -r .job.id)
sleep 3 && curl -s localhost:4000/api/demo/jobs/$POISON | jq '.job.status, .job.history[-1]'

# 4. Replay it — fresh retry budget, kept history (it dies again: still poisoned):
curl -s -X POST localhost:4000/api/demo/jobs/$POISON/requeue | jq '.job.status, .job.attempts'

# 5. Requeueing a job that is NOT dead → the canonical 400, with the WHY:
curl -s -X POST localhost:4000/api/demo/jobs/$JOB/requeue | jq .error

# 6. The two numbers that matter (queue depth, oldest age, DLQ size):
curl -s localhost:4000/api/demo/jobs/stats | jq

# 7. Feed the queue from a clock — one scheduler-sourced report per second:
curl -s -X POST localhost:4000/api/demo/jobs/scheduler \\
  -H 'content-type: application/json' -d '{"running":true,"intervalMs":1000}' | jq
sleep 2.5 && curl -s localhost:4000/api/demo/jobs | jq '.jobs[].payload' | head -8

# 8. Off means OFF — and the board reset (scheduler stops too):
curl -s -X POST localhost:4000/api/demo/jobs/scheduler \\
  -H 'content-type: application/json' -d '{"running":false}' | jq
curl -s -X DELETE localhost:4000/api/demo/jobs | jq`,
        },
      ],
    },
  ],
};

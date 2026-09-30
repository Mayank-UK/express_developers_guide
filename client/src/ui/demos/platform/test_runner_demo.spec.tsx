import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import TestRunnerDemo from './test_runner_demo';
import { stubApiFetch, stubNetworkFailure } from '../../../test/fetch_stub';

/**
 * The runner UI over stubs of GET /api/demo/testing/run. The server spec pins
 * the LIVE contract (twelve curated cases all passing against the real
 * modules, injectFailureFor flipping exactly one case, unknown ids → 400);
 * here we prove the component renders what that endpoint reports — the
 * summary strip, pass chips with module-of-origin notes, and the failed
 * case's expected vs actual.
 */

const RUN_URL = '/api/demo/testing/run';
const RUN_URL_INJECTED = `${RUN_URL}?injectFailureFor=jwt-tampered-payload`;

function case_(overrides: Partial<{ id: string; name: string; module: string; passed: boolean; expected: string; actual: string; ms: number }> = {}) {
  return {
    id: 'range-suffix-form',
    name: 'the suffix form bytes=-10 serves exactly the LAST 10 bytes',
    module: 'src/presentation/routes/files_demo_routes.ts',
    passed: true,
    expected: "parseRangeHeader('bytes=-10', 100) → satisfiable 90–99 (a 10-byte slice)",
    actual: "parseRangeHeader('bytes=-10', 100) → {\"kind\":\"satisfiable\",\"start\":90,\"end\":99}",
    ms: 0.21,
    ...overrides,
  };
}

const ALL_PASS = {
  total: 4,
  passed: 4,
  failed: 0,
  durationMs: 4.2,
  injectFailureFor: null,
  note: 'these are not fixtures — every case calls the real modules in this running process on every request',
  cases: [
    case_(),
    case_({
      id: 'i18n-wildcard-ranked-last',
      name: 'the wildcard serves the default locale only after every named range',
      module: 'src/domain/i18n/negotiate.ts',
    }),
    case_({
      id: 'jwt-tampered-payload',
      name: 'a tampered payload with the signature kept fails as signature_mismatch',
      module: 'src/domain/auth/jwt_service.ts',
      actual: "verifyJwt(…) → error reason 'signature_mismatch'",
    }),
    case_({
      id: 'jobs-backoff-within-jitter-bounds',
      name: 'retry #1 backs off ~300ms ± 20% jitter — never sync-locked, never unbounded',
      module: 'src/domain/jobs/job_queue.ts',
      actual: 'delayMs 312 (base 300 ± 20%); final status succeeded',
    }),
  ],
};

const ONE_INJECTED = {
  ...ALL_PASS,
  passed: 3,
  failed: 1,
  injectFailureFor: 'jwt-tampered-payload',
  cases: ALL_PASS.cases.map((entry) =>
    entry.id === 'jwt-tampered-payload'
      ? {
          ...entry,
          passed: false,
          expected:
            "verifyJwt('<header>.<forged payload>.<original signature>') → error reason 'signature_mismatch'",
          actual:
            "verifyJwt(…) → error reason 'signature_mismatch' [failure INJECTED via ?injectFailureFor — the assertion was flipped by request; the real verdict was PASS]",
        }
      : entry,
  ),
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('TestRunnerDemo — the run', () => {
  it('renders the all-pass list: summary strip, PASS chips, module-of-origin notes, durations', async () => {
    stubApiFetch([{ url: RUN_URL, body: ALL_PASS }]);

    render(<TestRunnerDemo />);
    fireEvent.click(screen.getByTestId('tr-run-button'));

    const summary = await screen.findByTestId('tr-summary', {}, { timeout: 4000 });
    expect(summary).toHaveTextContent('total: 4');
    expect(summary).toHaveTextContent('passed: 4');
    expect(summary).toHaveTextContent('failed: 0');
    expect(summary).toHaveTextContent('4.2ms');

    const rows = screen.getAllByTestId('tr-case');
    expect(rows).toHaveLength(4);
    const chips = screen.getAllByTestId('tr-case-chip').map((chip) => chip.textContent);
    expect(chips).toEqual(['PASS', 'PASS', 'PASS', 'PASS']);
    // Every row names the module the case exercises.
    expect(rows[0]).toHaveTextContent('module: src/presentation/routes/files_demo_routes.ts');
    expect(rows[3]).toHaveTextContent('module: src/domain/jobs/job_queue.ts');
    expect(rows[3]).toHaveTextContent('± 20% jitter');
    // All-pass: no expected/actual detail blocks render.
    expect(screen.queryByTestId('tr-case-detail')).toBeNull();
  }, 8000);

  it('renders a failed case with its expected vs actual when a failure is injected', async () => {
    stubApiFetch([
      { url: RUN_URL, body: ALL_PASS },
      { url: RUN_URL_INJECTED, body: ONE_INJECTED },
    ]);

    render(<TestRunnerDemo />);
    fireEvent.click(screen.getByTestId('tr-run-button'));
    await screen.findByTestId('tr-summary', {}, { timeout: 4000 });
    // The button may still read 'running…' when the summary first paints —
    // wait for the idle label so the second click lands on an ENABLED button.
    await screen.findByText('run the suite');

    // The honesty knob: pick the case to flip, then run again — the injected
    // request rides the URL (the stub dispatches on exactly that query).
    fireEvent.change(screen.getByTestId('tr-inject-select'), {
      target: { value: 'jwt-tampered-payload' },
    });
    fireEvent.click(screen.getByTestId('tr-run-button'));

    await waitFor(
      () => {
        expect(screen.getByTestId('tr-summary')).toHaveTextContent('failed: 1');
      },
      { timeout: 4000 },
    );
    expect(screen.getByTestId('tr-injected-note')).toHaveTextContent('jwt-tampered-payload');

    const chips = screen.getAllByTestId('tr-case-chip').map((chip) => chip.textContent);
    expect(chips).toEqual(['PASS', 'PASS', 'FAIL', 'PASS']);

    const expected = screen.getByTestId('tr-case-expected');
    const actual = screen.getByTestId('tr-case-actual');
    expect(expected).toHaveTextContent("error reason 'signature_mismatch'");
    expect(actual).toHaveTextContent('INJECTED');
    expect(actual).toHaveTextContent('the real verdict was PASS');
  }, 8000);

  it('degrades to the error strip when the server is unreachable', async () => {
    stubNetworkFailure();

    render(<TestRunnerDemo />);
    fireEvent.click(screen.getByTestId('tr-run-button'));

    await screen.findByTestId('tr-error');
    expect(screen.queryByTestId('tr-summary')).toBeNull();
  });
});

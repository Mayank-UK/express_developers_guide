import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import BestPracticesAuditDemo from './best_practices_audit_demo';
import { stubApiFetch, stubNetworkFailure } from '../../../test/fetch_stub';

/**
 * The self-audit demo renders the server's own report card; the spec pins
 * the grouping by category, the pass/warn/fail chips, the evidence lines,
 * the summary counts, and that RUN AUDIT re-grades.
 */

const AUDIT_URL = '/api/demo/best/audit';

function auditBody() {
  return {
    checks: [
      {
        id: 'helmet-headers',
        category: 'Security',
        practice: 'security headers on every response (helmet, CSP pinned)',
        status: 'pass',
        evidence: 'live self-fetch GET /api/health → x-content-type-options: nosniff',
      },
      {
        id: 'rate-limits-configured',
        category: 'Security',
        practice: 'rate limits on exposed endpoints',
        status: 'pass',
        evidence: 'express-rate-limit 5/60s + the handmade 3/30s twin',
      },
      {
        id: 'error-envelope',
        category: 'API discipline',
        practice: 'one error envelope for every failure',
        status: 'warn',
        evidence: 'self-fetch unavailable at this request origin — an unobservable check is a warn, not a guess',
      },
    ],
    summary: { pass: 2, warn: 1, fail: 0, total: 3 },
    note: 'the app grades itself',
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('BestPracticesAuditDemo — the report card', () => {
  it('groups checks by category with status chips and evidence lines', async () => {
    stubApiFetch([{ url: AUDIT_URL, body: auditBody() }]);
    render(<BestPracticesAuditDemo />);

    await screen.findAllByTestId('audit-check', {}, { timeout: 4000 });
    // Two categories, first-seen order preserved.
    const titles = screen.getAllByTestId('audit-group-title').map((node) => node.textContent);
    expect(titles).toEqual(['Security', 'API discipline']);
    // Three checks; chips carry their statuses; evidence lines render.
    expect(screen.getAllByTestId('audit-check')).toHaveLength(3);
    expect(screen.getAllByTestId('audit-chip').map((chip) => chip.textContent)).toEqual([
      'pass',
      'pass',
      'warn',
    ]);
    expect(screen.getAllByTestId('audit-evidence')[2]).toHaveTextContent('self-fetch unavailable');
    expect(screen.getByText('rate limits on exposed endpoints')).toBeInTheDocument();
  });

  it('renders the summary counts (X pass / Y warn / Z fail) and the total', async () => {
    stubApiFetch([{ url: AUDIT_URL, body: auditBody() }]);
    render(<BestPracticesAuditDemo />);

    await screen.findByTestId('audit-summary', {}, { timeout: 4000 });
    expect(screen.getByTestId('audit-summary')).toHaveTextContent('2 pass / 1 warn / 0 fail');
    expect(screen.getByText('3 checks')).toBeInTheDocument();
  });
});

describe('BestPracticesAuditDemo — run audit re-grades', () => {
  it('RUN AUDIT refires the fetch and renders the fresh summary', async () => {
    let callCount = 0;
    let failCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        callCount += 1;
        const body = auditBody();
        body.summary = { pass: 2 - failCount, warn: 1, fail: failCount, total: 3 };
        if (failCount > 0) {
          body.checks[0]!.status = 'fail';
          body.checks[0]!.evidence = 'live self-fetch answered without helmet\u2019s headers';
        }
        return { ok: true, status: 200, json: async () => body };
      }),
    );
    render(<BestPracticesAuditDemo />);

    await screen.findByTestId('audit-summary', {}, { timeout: 4000 });
    expect(screen.getByTestId('audit-summary')).toHaveTextContent('2 pass / 1 warn / 0 fail');
    expect(callCount).toBe(1);

    failCount = 1; // something regressed server-side
    fireEvent.click(screen.getByTestId('audit-run'));
    await waitFor(
      () => {
        expect(screen.getByTestId('audit-summary')).toHaveTextContent('1 pass / 1 warn / 1 fail');
      },
      { timeout: 4000 },
    );
    expect(callCount).toBe(2);
  });
});

describe('BestPracticesAuditDemo — failure states', () => {
  it('degrades to the error strip when the server is unreachable', async () => {
    stubNetworkFailure();
    render(<BestPracticesAuditDemo />);

    const error = await screen.findByTestId('audit-error', {}, { timeout: 4000 });
    expect(error).toHaveTextContent('unreachable');
    expect(screen.queryByTestId('audit-check')).toBeNull();
  });
});

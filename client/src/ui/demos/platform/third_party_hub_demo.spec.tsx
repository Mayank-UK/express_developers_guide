import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import ThirdPartyHubDemo from './third_party_hub_demo';

/**
 * The integration hub's contract, per panel:
 *
 * EMAIL — SEND posts to the adapter and the reloaded outbox lists the new
 * message (subject, to, messageId) with the captured-not-sent note visible.
 *
 * PAYMENTS — create intent renders the intent (masked client secret, status);
 * CONFIRM with 4242 shows the succeeded receipt; with the declined card the
 * outcome shows the decline code and the fallback status.
 *
 * STORAGE — PRESIGN renders the signed URL + expiry countdown; UPLOAD shows
 * the stored-file card with the file id.
 */

const EMAIL_SEND_URL = '/api/demo/email/send';
const EMAIL_OUTBOX_URL = '/api/demo/email/outbox';
const PAYMENTS_INTENT_URL = '/api/demo/payments/intent';
const PAYMENTS_CONFIRM_URL = '/api/demo/payments/confirm';
const STORAGE_PRESIGN_URL = '/api/demo/storage/presign';
const STORAGE_UPLOAD_URL = '/api/demo/storage/upload?token=Z3JhbnQ.c2ln';

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ThirdPartyHubDemo — email panel (the real adapter)', () => {
  it('SEND captures a message and the outbox lists it', async () => {
    const outbox: { messageId: string; to: string; subject: string; capturedAt: string }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url === EMAIL_OUTBOX_URL) return jsonResponse({ outbox: [...outbox], count: outbox.length });
        if (url === EMAIL_SEND_URL) {
          const sent = JSON.parse(String(init?.body ?? '{}')) as { to: string; subject: string };
          const entry = {
            messageId: '<captured-123@example.com>',
            to: sent.to,
            subject: sent.subject,
            capturedAt: new Date().toISOString(),
          };
          outbox.unshift(entry);
          return jsonResponse({ messageId: entry.messageId, accepted: [sent.to], capturedAt: entry.capturedAt }, 201);
        }
        return jsonResponse({ error: { code: 'not_found', message: `no stub for ${url}` } }, 404);
      }),
    );
    render(<ThirdPartyHubDemo />);

    await screen.findByText('the outbox is empty — send a message above.', {}, { timeout: 4000 });
    fireEvent.click(screen.getByTestId('thirdparty-email-send'));

    await screen.findByTestId('thirdparty-email-row', {}, { timeout: 4000 });
    expect(screen.getByTestId('thirdparty-email-row-subject')).toHaveTextContent('Welcome to the guide');
    expect(screen.getByTestId('thirdparty-email-row-to')).toHaveTextContent('student@example.com');
    expect(screen.getByTestId('thirdparty-email-last-id')).toHaveTextContent('messageId');
    expect(screen.getByText(/captured, not sent/i)).toBeInTheDocument();
  });

  it('renders the envelope message when the adapter rejects the input', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url === EMAIL_OUTBOX_URL) return jsonResponse({ outbox: [], count: 0 });
        if (url === EMAIL_SEND_URL) {
          return jsonResponse(
            { error: { code: 'validation_failed', message: '"to" must be an email address (something@host.tld)', requestId: 'r-1' } },
            400,
          );
        }
        return jsonResponse({ error: { code: 'not_found', message: `no stub for ${url}` } }, 404);
      }),
    );
    render(<ThirdPartyHubDemo />);

    await screen.findByText('the outbox is empty — send a message above.', {}, { timeout: 4000 });
    fireEvent.click(screen.getByTestId('thirdparty-email-send'));

    await screen.findByTestId('thirdparty-email-error', {}, { timeout: 4000 });
    expect(screen.getByTestId('thirdparty-email-error')).toHaveTextContent('"to" must be an email address');
  });
});

describe('ThirdPartyHubDemo — payments panel (the labeled mock)', () => {
  function stubPayments(declineInstead = false): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url === PAYMENTS_INTENT_URL) {
          return jsonResponse(
            {
              id: 'pi_mock_0001',
              amountCents: 1999,
              currency: 'usd',
              clientSecret: 'pi_mock_0001_secret_demo',
              status: 'requires_confirmation',
              mock: true,
            },
            201,
          );
        }
        if (url === PAYMENTS_CONFIRM_URL) {
          const body = JSON.parse(String(init?.body ?? '{}')) as { card: string };
          if (body.card.startsWith('4242') && !declineInstead) {
            return jsonResponse({
              paymentIntent: {
                id: 'pi_mock_0001',
                status: 'succeeded',
                latestCharge: { id: 'ch_mock_0001', receiptId: 'rcpt_mock_0001' },
              },
              receipt: { id: 'rcpt_mock_0001', at: new Date().toISOString() },
              mock: true,
            });
          }
          return jsonResponse({
            paymentIntent: {
              id: 'pi_mock_0001',
              status: 'requires_payment_method',
              lastPaymentError: { code: 'card_declined', decline_code: 'generic_decline', message: 'Your card was declined.' },
            },
            declineCode: 'card_declined',
            mock: true,
          });
        }
        return jsonResponse({ error: { code: 'not_found', message: `no stub for ${url}` } }, 404);
      }),
    );
  }

  it('create intent → confirm 4242 → the succeeded receipt', async () => {
    stubPayments();
    render(<ThirdPartyHubDemo />);

    fireEvent.click(screen.getByTestId('thirdparty-pay-create'));
    const intent = await screen.findByTestId('thirdparty-pay-intent', {}, { timeout: 4000 });
    expect(screen.getByTestId('thirdparty-pay-intent-id')).toHaveTextContent('pi_mock_0001');
    expect(screen.getByTestId('thirdparty-pay-intent-status')).toHaveTextContent('requires_confirmation');
    // The client secret is MASKED in the UI.
    expect(screen.getByTestId('thirdparty-pay-secret').textContent).not.toContain('secret_demo');
    expect(screen.getByTestId('thirdparty-pay-mock-badge')).toHaveTextContent('MOCK');
    expect(intent).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('thirdparty-pay-confirm'));
    const outcome = await screen.findByTestId('thirdparty-pay-outcome', {}, { timeout: 4000 });
    expect(outcome).toHaveTextContent('succeeded');
    expect(screen.getByTestId('thirdparty-pay-receipt')).toHaveTextContent('rcpt_mock_0001');
  });

  it('the declined card shows the decline code and the fallback status', async () => {
    stubPayments(true);
    render(<ThirdPartyHubDemo />);

    fireEvent.click(screen.getByTestId('thirdparty-pay-create'));
    await screen.findByTestId('thirdparty-pay-intent', {}, { timeout: 4000 });
    fireEvent.click(screen.getByTestId('thirdparty-pay-card-declined'));
    fireEvent.click(screen.getByTestId('thirdparty-pay-confirm'));

    const outcome = await screen.findByTestId('thirdparty-pay-outcome', {}, { timeout: 4000 });
    expect(outcome).toHaveTextContent('requires_payment_method');
    expect(screen.getByTestId('thirdparty-pay-decline')).toHaveTextContent('card_declined');
    expect(outcome).toHaveTextContent('generic_decline'); // Stripe's real decline_code field
  });
});

describe('ThirdPartyHubDemo — storage panel (the real ceremony)', () => {
  function stubStorage(): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url === STORAGE_PRESIGN_URL) {
          return jsonResponse(
            {
              uploadUrl: STORAGE_UPLOAD_URL,
              expiresAt: new Date(Date.now() + 300_000).toISOString(),
              expiresIn: 300,
              filename: 'demo-notes.txt',
              contentType: 'text/plain',
              mock: true,
            },
            201,
          );
        }
        if (url === STORAGE_UPLOAD_URL) {
          return jsonResponse(
            {
              file: {
                id: 'files-stored99',
                originalName: 'demo-notes.txt',
                mimeType: 'text/plain',
                size: String(init?.body ?? '').length,
              },
              rawUrl: '/api/demo/files/files-stored99/raw',
              mock: true,
            },
            201,
          );
        }
        return jsonResponse({ error: { code: 'not_found', message: `no stub for ${url}` } }, 404);
      }),
    );
  }

  it('PRESIGN shows the signed URL + countdown; UPLOAD shows the stored-file card', async () => {
    stubStorage();
    render(<ThirdPartyHubDemo />);

    expect(screen.queryByTestId('thirdparty-storage-grant')).toBeNull();
    fireEvent.click(screen.getByTestId('thirdparty-storage-presign'));

    const grant = await screen.findByTestId('thirdparty-storage-grant', {}, { timeout: 4000 });
    expect(screen.getByTestId('thirdparty-storage-url')).toHaveTextContent('/api/demo/storage/upload?token=Z3JhbnQ.c2ln');
    expect(screen.getByTestId('thirdparty-storage-countdown')).toHaveTextContent(/expires in \d+s/);

    fireEvent.click(screen.getByTestId('thirdparty-storage-upload'));
    const stored = await screen.findByTestId('thirdparty-storage-stored', {}, { timeout: 4000 });
    expect(grant).toBeInTheDocument();
    expect(stored).toBeInTheDocument();
    expect(screen.getByTestId('thirdparty-storage-stored-id')).toHaveTextContent('files-stored99');
    expect(stored).toHaveTextContent('/api/demo/files/files-stored99/raw');
  });

  it('renders the rejection reason when the upload answers the error envelope', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url === STORAGE_PRESIGN_URL) {
          return jsonResponse(
            {
              uploadUrl: STORAGE_UPLOAD_URL,
              expiresAt: new Date(Date.now() + 300_000).toISOString(),
              expiresIn: 300,
              filename: 'demo-notes.txt',
              contentType: 'text/plain',
            },
            201,
          );
        }
        if (url === STORAGE_UPLOAD_URL) {
          return jsonResponse(
            {
              error: {
                code: 'unauthorized',
                message: 'upload rejected: presign token expired at 2026-09-28T00:00:00.000Z',
                requestId: 'r-2',
                reason: 'expired',
              },
            },
            401,
          );
        }
        return jsonResponse({ error: { code: 'not_found', message: `no stub for ${url}` } }, 404);
      }),
    );
    render(<ThirdPartyHubDemo />);

    fireEvent.click(screen.getByTestId('thirdparty-storage-presign'));
    await screen.findByTestId('thirdparty-storage-grant', {}, { timeout: 4000 });
    fireEvent.click(screen.getByTestId('thirdparty-storage-upload'));

    const error = await screen.findByTestId('thirdparty-storage-error', {}, { timeout: 4000 });
    expect(error).toHaveTextContent('presign token expired');
    expect(screen.queryByTestId('thirdparty-storage-stored')).toBeNull();
  });
});

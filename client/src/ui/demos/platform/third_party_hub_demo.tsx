import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Demo for DemoBlock `thirdparty:hub` — the third-party services topic's
 * live surface: THREE panels at three levels of realness, each labeled the
 * way the content labels it —
 *
 * EMAIL: the REAL nodemailer adapter (jsonTransport). Send a message and the
 * outbox below shows what was captured — messageId, recipients, capturedAt.
 * Captured, not sent: no network, no account, nothing leaves the machine.
 *
 * PAYMENTS: a clearly-labeled MOCK that mirrors Stripe's shapes —
 * PaymentIntent, client secret, the status ladder, decline fields. 4242
 * succeeds with a receipt; "declined" falls back to requires_payment_method
 * with last_payment_error carrying the real field names.
 *
 * STORAGE: a REAL HMAC presign ceremony — presign mints the signed grant
 * (filename + content type + expiry), the upload button PUTs a tiny payload
 * through the granted URL, and the file lands in the files topic's REAL
 * store. Only the bucket is imaginary.
 *
 * Lives in demos/platform/ with its platform-group siblings (jobs, deps,
 * env, arch, …) — same choice the scaling and best-practices demos made.
 */

const EMAIL_SEND_URL = '/api/demo/email/send';
const EMAIL_OUTBOX_URL = '/api/demo/email/outbox';
const PAYMENTS_INTENT_URL = '/api/demo/payments/intent';
const PAYMENTS_CONFIRM_URL = '/api/demo/payments/confirm';
const STORAGE_PRESIGN_URL = '/api/demo/storage/presign';
/** The fixed payload the storage panel uploads through the presigned URL. */
const DEMO_UPLOAD_BODY = 'presigned demo payload — bytes straight into the real files store';

const BUTTON =
  'w-fit rounded-md border border-outline px-sm py-xs text-body-sm text-on-surface-variant hover:bg-surface-variant hover:text-on-surface disabled:opacity-50';
const BUTTON_PRIMARY =
  'w-fit rounded-md border border-outline bg-primary px-sm py-xs text-body-sm font-semibold text-on-primary hover:opacity-90 disabled:opacity-50';
const BUTTON_TOGGLED =
  'w-fit rounded-md border border-primary bg-primary px-sm py-xs text-body-sm font-semibold text-on-primary hover:opacity-90 disabled:opacity-50';
const CHIP =
  'rounded-md border border-outline px-xs py-xxs font-mono text-caption text-on-surface-variant';
const CHIP_BADGE =
  'rounded-md border border-outline bg-surface-variant px-xs py-xxs font-mono text-caption text-on-surface';
const INPUT =
  'w-full max-w-md rounded-md border border-outline bg-surface px-xs py-xxs font-mono text-caption text-on-surface';
const PANEL = 'flex flex-col gap-xs rounded-md border border-outline bg-surface p-sm';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The error envelope's message, or a generic unreachable line. */
async function errorMessageFrom(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as unknown;
    const message = isRecord(body) && isRecord(body.error) && typeof body.error.message === 'string'
      ? body.error.message
      : null;
    return message !== null && message !== '' ? message : `${fallback} (HTTP ${String(response.status)})`;
  } catch {
    return `${fallback} (HTTP ${String(response.status)})`;
  }
}

// --- email ---------------------------------------------------------------------

interface OutboxEntry {
  messageId: string;
  to: string;
  subject: string;
  capturedAt: string;
}

function parseOutbox(raw: unknown): OutboxEntry[] {
  if (!isRecord(raw) || !Array.isArray(raw.outbox)) return [];
  return raw.outbox.filter(
    (entry): entry is OutboxEntry =>
      isRecord(entry) &&
      typeof entry.messageId === 'string' &&
      typeof entry.to === 'string' &&
      typeof entry.subject === 'string' &&
      typeof entry.capturedAt === 'string',
  );
}

function clockOf(iso: string): string {
  return iso.length >= 19 ? iso.slice(11, 19) : iso;
}

// --- payments ------------------------------------------------------------------

type PayStatus = 'requires_confirmation' | 'succeeded' | 'requires_payment_method';

interface Intent {
  id: string;
  amountCents: number;
  currency: string;
  clientSecret: string;
  status: PayStatus;
  mock: boolean;
}

interface ConfirmOutcome {
  status: PayStatus;
  receipt?: { id: string; at: string };
  declineCode?: string;
  lastPaymentError?: { code: string; decline_code: string; message: string };
}

/** pi_mock_0001_secret_demo → pi_mock_000…_demo — the browser shows a SECRET masked. */
function maskSecret(secret: string): string {
  if (secret.length <= 16) return secret;
  return `${secret.slice(0, 13)}…${secret.slice(-4)}`;
}

function centsToDisplay(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

// --- storage -------------------------------------------------------------------

const CONTENT_TYPES = ['text/plain', 'image/jpeg', 'image/png', 'image/webp', 'application/pdf'] as const;

interface PresignGrant {
  uploadUrl: string;
  expiresAt: string;
  expiresIn: number;
  filename: string;
  contentType: string;
}

interface StoredFile {
  id: string;
  originalName: string;
  mimeType: string;
  size: number;
}

// --- the component ----------------------------------------------------------------

export default function ThirdPartyHubDemo(): ReactNode {
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  return (
    <div className="flex flex-col gap-md">
      <EmailPanel aliveRef={aliveRef} />
      <PaymentsPanel aliveRef={aliveRef} />
      <StoragePanel aliveRef={aliveRef} />
    </div>
  );
}

type AliveRef = { current: boolean };

// --- email panel ------------------------------------------------------------------

function EmailPanel({ aliveRef }: { aliveRef: AliveRef }): ReactNode {
  const [to, setTo] = useState('student@example.com');
  const [subject, setSubject] = useState('Welcome to the guide');
  const [text, setText] = useState('Chapter 1 is live — the outbox below is the proof.');
  const [outbox, setOutbox] = useState<OutboxEntry[] | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastMessageId, setLastMessageId] = useState<string | null>(null);

  const loadOutbox = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch(EMAIL_OUTBOX_URL);
      if (!aliveRef.current) return;
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
      setOutbox(parseOutbox(await response.json()));
    } catch {
      if (aliveRef.current) setError('the email API is unreachable');
    }
  }, [aliveRef]);

  useEffect(() => {
    void loadOutbox();
  }, [loadOutbox]);

  const send = async (): Promise<void> => {
    setSending(true);
    setError(null);
    try {
      const response = await fetch(EMAIL_SEND_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ to, subject, text }),
      });
      if (!aliveRef.current) return;
      if (!response.ok) {
        setError(await errorMessageFrom(response, 'send rejected'));
        return;
      }
      const body = (await response.json()) as unknown;
      if (isRecord(body) && typeof body.messageId === 'string') setLastMessageId(body.messageId);
      await loadOutbox();
    } catch {
      if (aliveRef.current) setError('the email API is unreachable');
    } finally {
      if (aliveRef.current) setSending(false);
    }
  };

  return (
    <section data-testid="thirdparty-email-panel" className={PANEL}>
      <div className="flex flex-wrap items-center gap-xs">
        <span className="text-body-sm font-semibold text-on-surface">1 · Email — real adapter</span>
        <span className={CHIP}>nodemailer · jsonTransport</span>
        <span className="text-caption text-on-surface-variant">
          captured, not sent — zero network, zero account
        </span>
      </div>

      <div className="flex flex-col gap-xxs">
        <label className="flex flex-wrap items-center gap-xs text-caption text-on-surface-variant">
          to
          <input
            data-testid="thirdparty-email-to"
            className={INPUT}
            value={to}
            onChange={(event) => setTo(event.target.value)}
          />
        </label>
        <label className="flex flex-wrap items-center gap-xs text-caption text-on-surface-variant">
          subject
          <input
            data-testid="thirdparty-email-subject"
            className={INPUT}
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
          />
        </label>
        <label className="flex flex-wrap items-center gap-xs text-caption text-on-surface-variant">
          text
          <input
            data-testid="thirdparty-email-text"
            className={INPUT}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-xs">
        <button type="button" data-testid="thirdparty-email-send" className={BUTTON_PRIMARY} disabled={sending} onClick={() => void send()}>
          {sending ? 'sending…' : 'send'}
        </button>
        {lastMessageId !== null && (
          <span data-testid="thirdparty-email-last-id" className={CHIP}>
            messageId {lastMessageId.slice(0, 22)}…
          </span>
        )}
        {error !== null && (
          <span data-testid="thirdparty-email-error" className="text-caption text-error">
            {error}
          </span>
        )}
      </div>

      <div data-testid="thirdparty-email-outbox" className="flex max-h-56 flex-col gap-xxs overflow-y-auto rounded-md border border-outline p-xs">
        {outbox === null && <p className="text-caption text-on-surface-variant">loading the outbox…</p>}
        {outbox !== null && outbox.length === 0 && (
          <p className="text-caption text-on-surface-variant">the outbox is empty — send a message above.</p>
        )}
        {outbox?.map((entry) => (
          <div
            key={entry.messageId}
            data-testid="thirdparty-email-row"
            className="flex flex-wrap items-center gap-xs font-mono text-caption text-on-surface"
          >
            <span data-testid="thirdparty-email-row-clock" className={CHIP_BADGE}>{clockOf(entry.capturedAt)}Z</span>
            <span data-testid="thirdparty-email-row-to">{entry.to}</span>
            <span className="text-on-surface-variant">·</span>
            <span data-testid="thirdparty-email-row-subject">{entry.subject}</span>
            <span className="text-on-surface-variant">· {entry.messageId.slice(0, 26)}…</span>
          </div>
        ))}
      </div>
    </section>
  );
}

// --- payments panel ----------------------------------------------------------------

function PaymentsPanel({ aliveRef }: { aliveRef: AliveRef }): ReactNode {
  const [amountCents, setAmountCents] = useState(1999);
  const [intent, setIntent] = useState<Intent | null>(null);
  const [card, setCard] = useState<'4242' | 'declined'>('4242');
  const [outcome, setOutcome] = useState<ConfirmOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const createIntent = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setIntent(null);
    setOutcome(null);
    try {
      const response = await fetch(PAYMENTS_INTENT_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ amountCents, currency: 'usd' }),
      });
      if (!aliveRef.current) return;
      if (!response.ok) {
        setError(await errorMessageFrom(response, 'intent rejected'));
        return;
      }
      const body = (await response.json()) as unknown;
      if (
        isRecord(body) &&
        typeof body.id === 'string' &&
        typeof body.clientSecret === 'string' &&
        (body.status === 'requires_confirmation' || body.status === 'succeeded' || body.status === 'requires_payment_method')
      ) {
        setIntent({
          id: body.id,
          amountCents: typeof body.amountCents === 'number' ? body.amountCents : 0,
          currency: typeof body.currency === 'string' ? body.currency : 'usd',
          clientSecret: body.clientSecret,
          status: body.status,
          mock: body.mock === true,
        });
      }
    } catch {
      if (aliveRef.current) setError('the payments API is unreachable');
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  };

  const confirm = async (): Promise<void> => {
    if (intent === null) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(PAYMENTS_CONFIRM_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ paymentIntentId: intent.id, card }),
      });
      if (!aliveRef.current) return;
      if (!response.ok) {
        setError(await errorMessageFrom(response, 'confirm rejected'));
        return;
      }
      const body = (await response.json()) as unknown;
      if (!isRecord(body) || !isRecord(body.paymentIntent)) return;
      const pi = body.paymentIntent;
      const status = pi.status;
      if (status !== 'succeeded' && status !== 'requires_payment_method' && status !== 'requires_confirmation') return;
      const receipt = isRecord(body.receipt) && typeof body.receipt.id === 'string' && typeof body.receipt.at === 'string'
        ? { id: body.receipt.id as string, at: body.receipt.at as string }
        : undefined;
      setOutcome({
        status,
        receipt,
        ...(typeof body.declineCode === 'string' && { declineCode: body.declineCode }),
        ...(isRecord(pi.lastPaymentError) &&
          typeof pi.lastPaymentError.code === 'string' && {
            lastPaymentError: {
              code: pi.lastPaymentError.code,
              decline_code: typeof pi.lastPaymentError.decline_code === 'string' ? pi.lastPaymentError.decline_code : '',
              message: typeof pi.lastPaymentError.message === 'string' ? pi.lastPaymentError.message : '',
            },
          }),
      });
    } catch {
      if (aliveRef.current) setError('the payments API is unreachable');
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  };

  return (
    <section data-testid="thirdparty-pay-panel" className={PANEL}>
      <div className="flex flex-wrap items-center gap-xs">
        <span className="text-body-sm font-semibold text-on-surface">2 · Payments — Stripe-shaped</span>
        <span data-testid="thirdparty-pay-mock-badge" className={CHIP_BADGE}>
          MOCK — no money moves
        </span>
        <span className="text-caption text-on-surface-variant">
          the shapes mirror Stripe; the real flow is sketched in the content
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-xs">
        <label className="flex items-center gap-xs text-caption text-on-surface-variant">
          amount (cents)
          <input
            data-testid="thirdparty-pay-amount"
            className={`${INPUT} w-28`}
            inputMode="numeric"
            value={String(amountCents)}
            onChange={(event) => {
              const parsed = Number(event.target.value.replace(/[^0-9]/g, ''));
              setAmountCents(Number.isFinite(parsed) ? parsed : 0);
            }}
          />
        </label>
        <span className={CHIP}>{centsToDisplay(amountCents)}</span>
        <button type="button" data-testid="thirdparty-pay-create" className={BUTTON_PRIMARY} disabled={busy} onClick={() => void createIntent()}>
          create intent
        </button>
      </div>

      {intent !== null && (
        <div data-testid="thirdparty-pay-intent" className="flex flex-col gap-xxs rounded-md border border-outline p-xs">
          <div className="flex flex-wrap items-center gap-xs font-mono text-caption text-on-surface">
            <span data-testid="thirdparty-pay-intent-id">{intent.id}</span>
            <span className={CHIP}>{centsToDisplay(intent.amountCents)} {intent.currency}</span>
            <span data-testid="thirdparty-pay-intent-status" className={CHIP_BADGE}>
              {intent.status}
            </span>
          </div>
          <div className="font-mono text-caption text-on-surface-variant">
            clientSecret <span data-testid="thirdparty-pay-secret">{maskSecret(intent.clientSecret)}</span> — the one
            credential meant for the browser; the client confirms, the webhook tells the truth.
          </div>

          <div className="flex flex-wrap items-center gap-xs">
            <span className="text-caption text-on-surface-variant">test card:</span>
            <button
              type="button"
              data-testid="thirdparty-pay-card-success"
              className={card === '4242' ? BUTTON_TOGGLED : BUTTON}
              onClick={() => setCard('4242')}
            >
              4242… (succeeds)
            </button>
            <button
              type="button"
              data-testid="thirdparty-pay-card-declined"
              className={card === 'declined' ? BUTTON_TOGGLED : BUTTON}
              onClick={() => setCard('declined')}
            >
              declined
            </button>
            <button type="button" data-testid="thirdparty-pay-confirm" className={BUTTON_PRIMARY} disabled={busy} onClick={() => void confirm()}>
              confirm
            </button>
          </div>
        </div>
      )}

      {outcome !== null && (
        <div
          data-testid="thirdparty-pay-outcome"
          className={`flex flex-col gap-xxs rounded-md border p-xs ${
            outcome.status === 'succeeded' ? 'border-primary' : 'border-error'
          }`}
        >
          {outcome.status === 'succeeded' && outcome.receipt !== undefined ? (
            <>
              <div className="flex flex-wrap items-center gap-xs">
                <span className={CHIP_BADGE}>succeeded</span>
                <span data-testid="thirdparty-pay-receipt" className="font-mono text-caption text-on-surface">
                  receipt {outcome.receipt.id} · {clockOf(outcome.receipt.at)}Z
                </span>
              </div>
              <p className="text-caption text-on-surface-variant">
                these are the shapes a <span className="font-mono">payment_intent.succeeded</span> webhook delivers —
                the SERVER fulfills on that event, never on the client&apos;s redirect.
              </p>
            </>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-xs">
                <span className={CHIP_BADGE}>requires_payment_method</span>
                <span data-testid="thirdparty-pay-decline" className="font-mono text-caption text-error">
                  declineCode {outcome.declineCode ?? outcome.lastPaymentError?.code ?? 'card_declined'}
                </span>
              </div>
              <p className="font-mono text-caption text-on-surface-variant">
                last_payment_error: code={outcome.lastPaymentError?.code ?? 'card_declined'} decline_code=
                {outcome.lastPaymentError?.decline_code ?? 'generic_decline'} — Stripe&apos;s real field names; the
                status fell BACK so the customer keeps their place in the flow.
              </p>
            </>
          )}
        </div>
      )}

      {error !== null && (
        <p data-testid="thirdparty-pay-error" className="text-caption text-error">
          {error}
        </p>
      )}
    </section>
  );
}

// --- storage panel -----------------------------------------------------------------

function StoragePanel({ aliveRef }: { aliveRef: AliveRef }): ReactNode {
  const [filename, setFilename] = useState('demo-notes.txt');
  const [contentType, setContentType] = useState<string>('text/plain');
  const [grant, setGrant] = useState<PresignGrant | null>(null);
  const [stored, setStored] = useState<StoredFile | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  // The expiry countdown — one tick per second while a grant is showing.
  useEffect(() => {
    if (grant === null) return;
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [grant]);

  const presign = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setGrant(null);
    setStored(null);
    try {
      const response = await fetch(STORAGE_PRESIGN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filename, contentType }),
      });
      if (!aliveRef.current) return;
      if (!response.ok) {
        setError(await errorMessageFrom(response, 'presign rejected'));
        return;
      }
      const body = (await response.json()) as unknown;
      if (
        isRecord(body) &&
        typeof body.uploadUrl === 'string' &&
        typeof body.expiresAt === 'string' &&
        typeof body.expiresIn === 'number'
      ) {
        setNowMs(Date.now());
        setGrant({
          uploadUrl: body.uploadUrl,
          expiresAt: body.expiresAt,
          expiresIn: body.expiresIn,
          filename: typeof body.filename === 'string' ? body.filename : filename,
          contentType: typeof body.contentType === 'string' ? body.contentType : contentType,
        });
      }
    } catch {
      if (aliveRef.current) setError('the storage API is unreachable');
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  };

  const upload = async (): Promise<void> => {
    if (grant === null) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(grant.uploadUrl, {
        method: 'POST',
        headers: { 'content-type': grant.contentType },
        body: DEMO_UPLOAD_BODY,
      });
      if (!aliveRef.current) return;
      if (!response.ok) {
        setError(await errorMessageFrom(response, 'upload rejected'));
        return;
      }
      const body = (await response.json()) as unknown;
      if (
        isRecord(body) &&
        isRecord(body.file) &&
        typeof body.file.id === 'string' &&
        typeof body.file.originalName === 'string'
      ) {
        setStored({
          id: body.file.id,
          originalName: body.file.originalName,
          mimeType: typeof body.file.mimeType === 'string' ? body.file.mimeType : '',
          size: typeof body.file.size === 'number' ? body.file.size : 0,
        });
      }
    } catch {
      if (aliveRef.current) setError('the storage API is unreachable');
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  };

  const remainingSeconds =
    grant === null ? null : Math.max(0, Math.ceil((Date.parse(grant.expiresAt) - nowMs) / 1000));
  const grantExpired = remainingSeconds !== null && remainingSeconds === 0;

  return (
    <section data-testid="thirdparty-storage-panel" className={PANEL}>
      <div className="flex flex-wrap items-center gap-xs">
        <span className="text-body-sm font-semibold text-on-surface">3 · Storage — real presign ceremony</span>
        <span className={CHIP}>hmac-sha256 · the files topic&apos;s real store</span>
        <span className="text-caption text-on-surface-variant">only the bucket is imaginary</span>
      </div>

      <div className="flex flex-wrap items-center gap-xs">
        <label className="flex items-center gap-xs text-caption text-on-surface-variant">
          filename
          <input
            data-testid="thirdparty-storage-filename"
            className={`${INPUT} w-48`}
            value={filename}
            onChange={(event) => setFilename(event.target.value)}
          />
        </label>
        <label className="flex items-center gap-xs text-caption text-on-surface-variant">
          content type
          <select
            data-testid="thirdparty-storage-type"
            className={INPUT}
            value={contentType}
            onChange={(event) => setContentType(event.target.value)}
          >
            {CONTENT_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </label>
        <button type="button" data-testid="thirdparty-storage-presign" className={BUTTON_PRIMARY} disabled={busy} onClick={() => void presign()}>
          presign
        </button>
      </div>

      {grant !== null && (
        <div data-testid="thirdparty-storage-grant" className="flex flex-col gap-xxs rounded-md border border-outline p-xs">
          <div className="flex flex-wrap items-center gap-xs font-mono text-caption text-on-surface">
            <span data-testid="thirdparty-storage-url" className="break-all">
              {grant.uploadUrl.slice(0, 64)}…
            </span>
            <span data-testid="thirdparty-storage-countdown" className={grantExpired ? CHIP_BADGE : CHIP}>
              {grantExpired ? 'expired' : `expires in ${String(remainingSeconds)}s`}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-xs">
            <button
              type="button"
              data-testid="thirdparty-storage-upload"
              className={BUTTON_PRIMARY}
              disabled={busy || grantExpired}
              onClick={() => void upload()}
            >
              upload a tiny payload
            </button>
            <span className="text-caption text-on-surface-variant">
              the token binds filename + content type + expiry — the upload verifies all three
            </span>
          </div>
        </div>
      )}

      {stored !== null && (
        <div data-testid="thirdparty-storage-stored" className="flex flex-wrap items-center gap-xs rounded-md border border-primary p-xs">
          <span className={CHIP_BADGE}>stored</span>
          <span className="font-mono text-caption text-on-surface">
            <span data-testid="thirdparty-storage-stored-id">{stored.id}</span> · {stored.originalName} ·{' '}
            {stored.mimeType} · {String(stored.size)}B
          </span>
          <span className="text-caption text-on-surface-variant">
            a REAL file in the REAL store — fetch it at /api/demo/files/{stored.id}/raw
          </span>
        </div>
      )}

      {error !== null && (
        <p data-testid="thirdparty-storage-error" className="text-caption text-error">
          {error}
        </p>
      )}
    </section>
  );
}

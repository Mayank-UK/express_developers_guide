import { failure, type Failure } from '../../core/error_handling/failures.js';
import { fail, ok, type Result } from '../../core/result/result.js';

/**
 * The third-party topic's email boundary — the ports-and-adapters lesson in
 * miniature, and this file is now EXACTLY what that lesson prescribes: a
 * domain service that names its dependency as a PORT (EmailTransporter below)
 * and constructs NOTHING. This file does not import nodemailer at all — the
 * composition root constructs the transporter and injects it. In this build
 * that is `nodemailer.createTransport({ jsonTransport: true })`: nodemailer
 * runs its entire real pipeline (address parsing, header building, message
 * assembly, messageId minting) and then HANDS YOU THE MESSAGE AS JSON instead
 * of opening a socket — zero network, zero account, zero SMTP credentials,
 * which is exactly why it is also the standard test/dev transport for real
 * apps. Swap the ONE construction in the container for
 * `createTransport({ host, port, auth })` and everything above it (this
 * service, the queue's email jobs, the routes, the specs) is unchanged: THAT
 * is what "wrap the vendor behind your interface" buys.
 *
 * This service is the piece the background-jobs topic promised when its email
 * handler used a simulated sender: the queue's contract stays identical; only
 * the adapter at the bottom of the stack changes.
 */

/** Demo sender identity — a real deployment sets this from config/SES/SRP domain. */
export const EMAIL_FROM_ADDRESS = 'express-guide@example.com';

/** The outbox is a window, not a log — capped like every teaching store here. */
export const EMAIL_OUTBOX_CAP = 50;

/** Simulated remote-hop latency: a real SMTP/HTTPS round trip is never 0ms. */
const LATENCY_MIN_MS = 30;
const LATENCY_MAX_MS = 80;

const SUBJECT_MAX_LENGTH = 200;
const TEXT_MAX_LENGTH = 5000;
const HTML_MAX_LENGTH = 20000;

/** The message shape callers speak — OUR interface, not nodemailer's options bag. */
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  /** Optional HTML alternative; the plain-text part is ALWAYS required. */
  html?: string;
}

/** The mail the service hands a transport — our trimmed shape of the vendor's options bag. */
export interface EmailTransportMail {
  from: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/**
 * What a successful transport send resolves — jsonTransport's
 * { envelope, messageId, message } exactly (nodemailer's own SentMessageInfo
 * for the JSON transport is `any`; the port narrows it once, here).
 */
export interface EmailSendInfo {
  envelope?: unknown;
  messageId: string;
  message?: unknown;
}

/**
 * The transporter PORT — "something that can send a message" as the domain
 * sees it, in OUR vocabulary. It is STRUCTURAL on purpose: nodemailer's
 * Transporter satisfies it without an adapter class, and so does any fake a
 * spec writes inline — TypeScript structural typing is what lets the domain
 * own the interface while the vendor never appears in this file.
 */
export interface EmailTransporter {
  sendMail(mail: EmailTransportMail): Promise<EmailSendInfo>;
}

/** What a successful send returns — the receipt a job or route records. */
export interface EmailSendReceipt {
  messageId: string;
  /** Addresses the transport accepted (from its resolved envelope). */
  accepted: string[];
  /** ISO instant the message was captured. */
  capturedAt: string;
}

/** One captured message — jsonTransport's JSON, plus our receipt fields. */
export interface OutboxEntry extends EmailSendReceipt {
  to: string;
  subject: string;
  text: string;
  html?: string;
  from: string;
  /** The full JSON nodemailer produced (the transport's actual output). */
  transportMessage: string;
}

export interface EmailServiceOptions {
  /**
   * The transporter, REQUIRED — the domain constructs no infrastructure. The
   * composition root hands in the vendor instance (nodemailer's jsonTransport
   * in this build); specs hand in fakes. "Which transport" is wiring, not
   * domain logic, and wiring lives at the composition root.
   */
  readonly transporter: EmailTransporter;
  /** Sleep override (ms) — injectable for deterministic tests. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Clock override — injectable for deterministic tests. */
  readonly now?: () => Date;
}

export class EmailService {
  private readonly transporter: EmailTransporter;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => Date;
  /** Newest first, capped — unshift + splice, the webhook inbox's shape. */
  private readonly outbox: OutboxEntry[] = [];

  constructor(options: EmailServiceOptions) {
    this.transporter = options.transporter;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Validate, hand to the transport, capture. Failures are VALUES (Result),
   * never throws — the domain's rule; the route edge maps them to the 400
   * envelope. A real transport's transient errors would surface as
   * `unavailable` failures here, which is precisely what the jobs queue's
   * retry budget exists to absorb.
   */
  async send(message: EmailMessage): Promise<Result<EmailSendReceipt, Failure>> {
    const validation = this.validate(message);
    if (validation !== undefined) return fail(validation);

    // Simulate the remote hop BEFORE the call — the point is that "send email"
    // is a network round trip, not a function call, and the caller's latency
    // budget should be built with that in mind.
    await this.sleep(LATENCY_MIN_MS + Math.random() * (LATENCY_MAX_MS - LATENCY_MIN_MS));

    // The port's reply type is exactly jsonTransport's { envelope, messageId,
    // message } — asserted once at the port, so this body stays vendor-blind.
    let info: EmailSendInfo;
    try {
      info = await this.transporter.sendMail({
        from: EMAIL_FROM_ADDRESS,
        to: message.to,
        subject: message.subject,
        text: message.text,
        ...(message.html !== undefined && { html: message.html }),
      });
    } catch (error) {
      // jsonTransport cannot realistically fail here (no I/O), but the shape
      // is the honest adapter contract for the day the transport is real.
      return fail(
        failure('unavailable', 'the email transport rejected the send', {
          reason: 'transport_error',
          detail: error instanceof Error ? error.message : String(error),
        }),
      );
    }

    // jsonTransport resolves { envelope, messageId, message } — there is no
    // `accepted` array (nothing was sent anywhere). The ENVELOPE it resolved
    // is the honest "what the transport took" — derive accepted from it.
    const envelopeAddresses = (info.envelope as { to?: string | string[] } | undefined)?.to ?? [];
    const accepted = (Array.isArray(envelopeAddresses) ? envelopeAddresses : [envelopeAddresses])
      .map((address) => (typeof address === 'string' ? address : String(address)))
      .filter((address) => address !== '');

    const capturedAt = this.now().toISOString();
    const entry: OutboxEntry = {
      messageId: info.messageId,
      accepted,
      capturedAt,
      to: message.to,
      subject: message.subject,
      text: message.text,
      ...(message.html !== undefined && { html: message.html }),
      from: EMAIL_FROM_ADDRESS,
      transportMessage: String(info.message),
    };
    this.outbox.unshift(entry);
    this.outbox.splice(EMAIL_OUTBOX_CAP);

    return ok({ messageId: entry.messageId, accepted: entry.accepted, capturedAt });
  }

  /** The captured messages, newest first (the demo's outbox view). */
  listOutbox(): readonly OutboxEntry[] {
    return this.outbox;
  }

  /** Spec/demo reset: drop the captured messages (the transport is stateless). */
  clear(): void {
    this.outbox.length = 0;
  }

  private validate(message: EmailMessage): Failure | undefined {
    if (typeof message.to !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(message.to.trim())) {
      return failure('validation', '"to" must be an email address (something@host.tld)', {
        parameter: 'to',
        received: typeof message.to === 'string' ? message.to : typeof message.to,
      });
    }
    const subject = message.subject;
    if (typeof subject !== 'string' || subject.trim() === '') {
      return failure('validation', '"subject" is required', { parameter: 'subject' });
    }
    if (subject.length > SUBJECT_MAX_LENGTH) {
      return failure('validation', `"subject" must be at most ${String(SUBJECT_MAX_LENGTH)} characters`, {
        parameter: 'subject',
        receivedLength: subject.length,
        maxLength: SUBJECT_MAX_LENGTH,
      });
    }
    if (typeof message.text !== 'string' || message.text.trim() === '') {
      return failure('validation', '"text" is required (the plain-text part is never optional)', {
        parameter: 'text',
      });
    }
    if (message.text.length > TEXT_MAX_LENGTH) {
      return failure('validation', `"text" must be at most ${String(TEXT_MAX_LENGTH)} characters`, {
        parameter: 'text',
        receivedLength: message.text.length,
        maxLength: TEXT_MAX_LENGTH,
      });
    }
    if (message.html !== undefined && message.html.length > HTML_MAX_LENGTH) {
      return failure('validation', `"html" must be at most ${String(HTML_MAX_LENGTH)} characters`, {
        parameter: 'html',
        receivedLength: message.html.length,
        maxLength: HTML_MAX_LENGTH,
      });
    }
    return undefined;
  }
}

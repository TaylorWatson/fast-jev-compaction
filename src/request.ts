import type { JevAnswer, JevQuestions, JevResponse, JevState } from './types.js';

export const SYSTEM_ONE_URL = 'https://api.typesafe.ai/v1/systemone';
export const DEFAULT_MODEL = 'jev-latest';

export interface JevRequest {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: string;
}

/** The HTTP request for one Jev call, for any fetch-like transport. */
export function buildJevRequest(
  params: {
    apiKey: string;
    model?: string;
    baseUrl?: string;
  },
  state: JevState,
  questions: JevQuestions,
): JevRequest {
  return {
    url: params.baseUrl ?? SYSTEM_ONE_URL,
    method: 'POST',
    headers: {
      authorization: `Bearer ${params.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: params.model ?? DEFAULT_MODEL,
      state,
      questions,
    }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Every failure a Jev call can raise. `retryable` is the one place that says
 * whether another attempt could help; a plain `Error` from elsewhere never is.
 */
export abstract class JevError extends Error {
  constructor(message: string, name: string) {
    super(message);
    this.name = name;
  }
  get retryable(): boolean {
    return false;
  }
}

/** A non-2xx answer from the endpoint; `status` decides whether a retry makes sense. */
export class JevRequestError extends JevError {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string, message?: string) {
    super(message ?? `Jev request failed (${status}): ${body.slice(0, 200)}`, 'JevRequestError');
    this.status = status;
    this.body = body;
  }
  /** 429 and 5xx are transient by contract; anything else is the request's fault. */
  override get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

/** The caller gave up, or the URL itself is wrong: neither is the network's fault. */
function permanentTransportFailure(cause: unknown): boolean {
  if (!isRecord(cause)) return false;
  const message = typeof cause.message === 'string' ? cause.message : '';
  return (
    cause.name === 'AbortError' ||
    cause.code === 'ERR_INVALID_URL' ||
    /invalid url|failed to parse url/i.test(message)
  );
}

/**
 * The transport failed before any status came back (DNS, TLS, a dropped
 * connection); retried like a 5xx. The built-in transports wrap a throwing
 * fetch in one; a custom `JevAsker` throws it to opt a failure into retries.
 */
export class JevTransportError extends JevError {
  override readonly cause: unknown;
  constructor(cause: unknown) {
    super(`Jev transport failed: ${cause instanceof Error ? cause.message : String(cause)}`, 'JevTransportError');
    this.cause = cause;
  }
  override get retryable(): boolean {
    return !permanentTransportFailure(this.cause);
  }
}

/** A 2xx answer whose body is not a valid Jev response; never retried. */
export class JevResponseError extends JevError {
  constructor(message: string) {
    super(message, 'JevResponseError');
  }
}

/** Validates a Jev response body; throws on anything but an `answers` object. */
export function parseJevResponse(
  status: number,
  ok: boolean,
  text: string,
): JevResponse {
  if (!ok) {
    if (
      status === 403 &&
      /<\s*(?:!doctype\s+html|html)\b/i.test(text.slice(0, 1024))
    ) {
      throw new JevRequestError(
        status,
        text,
        'Jev request failed (403): the endpoint returned an HTML error page; a web firewall or proxy may be blocking this request',
      );
    }
    throw new JevRequestError(status, text);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new JevResponseError('Jev returned malformed JSON');
  }
  if (!isRecord(parsed) || !isRecord(parsed.answers)) {
    throw new JevResponseError('Jev response is missing answers');
  }
  return parsed as JevResponse;
}

/** The `noul` probability of one answer; throws when it is not there. */
export function noulAnswer(
  answers: Record<string, JevAnswer>,
  name: string,
): number {
  const answer: unknown = isRecord(answers) && Object.hasOwn(answers, name)
    ? answers[name]
    : undefined;
  if (
    !isRecord(answer) ||
    !Object.hasOwn(answer, 'noul') ||
    (answer.type !== undefined && answer.type !== 'noul') ||
    typeof answer.noul !== 'number' ||
    !Number.isFinite(answer.noul) ||
    answer.noul < 0 || answer.noul > 1
  ) {
    throw new JevResponseError(`Invalid Jev answer for ${name}`);
  }
  return answer.noul;
}

export class OpenAIOAuthError extends Error {
  constructor(
    message: string,
    readonly options: { status?: number; code?: string; param?: string; requestId?: string; retry?: 'none' | 'backoff' | 'reauthorize'; cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'OpenAIOAuthError';
  }
}

export async function responseError(response: Response): Promise<OpenAIOAuthError> {
  const requestId = response.headers.get('x-request-id') ?? undefined;
  let body: unknown;
  try { body = await response.json(); } catch { body = await response.text().catch(() => ''); }
  const error = typeof body === 'object' && body !== null && 'error' in body
    ? (body as { error?: { message?: string; code?: string; param?: string } }).error
    : undefined;
  const detail = typeof body === 'object' && body !== null && 'detail' in body
    ? String((body as { detail: unknown }).detail)
    : undefined;
  return new OpenAIOAuthError(redact(error?.message ?? detail ?? `OpenAI request failed (${response.status})`), {
    status: response.status, code: error?.code, param: error?.param, requestId, retry: retryGuidance(error?.code),
  });
}

export function errorFromEvent(event: Record<string, unknown>, requestId?: string): OpenAIOAuthError {
  const failure = isRecord(event.response) && isRecord(event.response.error) ? event.response.error : event;
  return new OpenAIOAuthError(redact(stringValue(failure.message) ?? `OpenAI response ${String(event.type ?? 'error')}.`), {
    code: stringValue(failure.code), param: stringValue(failure.param), requestId, retry: retryGuidance(stringValue(failure.code)),
  });
}

function retryGuidance(code?: string): 'none' | 'backoff' | 'reauthorize' {
  if (['subscription_sharing_usage_unavailable', 'subscription_sharing_user_unavailable'].includes(code ?? '')) return 'backoff';
  if (['subscription_sharing_invalid_user', 'chatpass_v2_scope_not_authorized', 'chatpass_v2_invalid_authorization_context'].includes(code ?? '')) return 'reauthorize';
  return 'none';
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null; }
function stringValue(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined; }
function redact(message: string): string { return message.replace(/Bearer\s+[^\s]+/gi, 'Bearer [REDACTED]').replace(/https?:\/\/[^\s]+/gi, '[REDACTED URL]'); }

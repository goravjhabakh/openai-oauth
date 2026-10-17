export class OpenAIOAuthError extends Error {
  constructor(
    message: string,
    readonly options: { status?: number; code?: string; param?: string; requestId?: string; cause?: unknown } = {},
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
  return new OpenAIOAuthError(error?.message ?? detail ?? `OpenAI request failed (${response.status})`, {
    status: response.status, code: error?.code, param: error?.param, requestId,
  });
}

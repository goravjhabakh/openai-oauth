import { OpenAIOAuthError, errorFromEvent, responseError } from './errors.js';

export interface ResponsesClientOptions { accessToken(): Promise<string>; fetch?: typeof fetch }

export interface ResponsesStream {
  headers: Headers;
  events: AsyncGenerator<Record<string, unknown>>;
}

export class ResponsesClient {
  private readonly fetch: typeof fetch;
  constructor(private readonly options: ResponsesClientOptions) { this.fetch = options.fetch ?? globalThis.fetch; }

  async stream(body: unknown, signal?: AbortSignal): Promise<ResponsesStream> {
    const response = await this.fetch('https://api.openai.com/v1/responses', {
      method: 'POST', signal, headers: { authorization: `Bearer ${await this.options.accessToken()}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!response.ok) throw await responseError(response);
    if (!response.body) throw new OpenAIOAuthError('OpenAI returned an empty streaming response.', { requestId: response.headers.get('x-request-id') ?? undefined });
    return { headers: response.headers, events: parseSse(response.body, signal) };
  }

  async generate(body: unknown, signal?: AbortSignal): Promise<{ terminal: ResponseTerminal; headers: Headers; events: Record<string, unknown>[] }> {
    const { headers, events } = await this.stream(body, signal);
    const collected: Record<string, unknown>[] = [];
    let terminal: ResponseTerminal | undefined;
    for await (const event of events) {
      collected.push(event);
      if (event.type === 'response.completed') terminal = event.response as ResponseTerminal;
      if (event.type === 'response.failed' || event.type === 'response.incomplete') {
        throw errorFromEvent(event, headers.get('x-request-id') ?? undefined);
      }
      if (event.type === 'error') throw errorFromEvent(event, headers.get('x-request-id') ?? undefined);
    }
    if (!terminal) throw new OpenAIOAuthError('OpenAI stream ended before response.completed.', { requestId: headers.get('x-request-id') ?? undefined });
    return { terminal, headers, events: collected };
  }
}

export interface ResponseTerminal { id?: string; status?: string; model?: string; created_at?: number; usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number }; output_tokens_details?: { reasoning_tokens?: number } } }

export async function* parseSse(stream: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<Record<string, unknown>> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const abort = () => { void reader.cancel(); };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += value ? decoder.decode(value, { stream: !done }) : '';
      const chunks = buffer.split(/\r?\n\r?\n/);
      buffer = chunks.pop() ?? '';
      for (const chunk of chunks) {
        const data = chunk.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!data || data === '[DONE]') continue;
        try { yield JSON.parse(data) as Record<string, unknown>; }
        catch { throw new OpenAIOAuthError('OpenAI returned malformed SSE JSON.'); }
      }
      if (done) break;
    }
    if (buffer.trim()) {
      const data = buffer.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (data && data !== '[DONE]') {
        try { yield JSON.parse(data) as Record<string, unknown>; }
        catch { throw new OpenAIOAuthError('OpenAI returned malformed SSE JSON.'); }
      }
    }
  } finally {
    signal?.removeEventListener('abort', abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

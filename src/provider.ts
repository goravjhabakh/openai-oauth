import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4GenerateResult, LanguageModelV4StreamPart, LanguageModelV4StreamResult, SharedV4Warning } from '@ai-sdk/provider';
import { OpenAIOAuth } from './auth.js';
import { OpenAIOAuthError } from './errors.js';
import { ResponsesClient } from './responses.js';
import type { ResponseTerminal } from './responses.js';
import type { OpenAIOAuthOptions } from './auth.js';

export interface OpenAIOAuthProvider {
  (modelId: string): LanguageModelV4;
  languageModel(modelId: string): LanguageModelV4;
  auth: OpenAIOAuth;
}

/** Creates an OAuth-authenticated provider. Sign in with `provider.auth.signIn()` first. */
export function createOpenAIOAuth(options: OpenAIOAuthOptions): OpenAIOAuthProvider {
  const auth = new OpenAIOAuth(options);
  const factory = ((modelId: string) => new OpenAIOAuthLanguageModel(modelId, auth)) as unknown as OpenAIOAuthProvider;
  factory.languageModel = factory;
  factory.auth = auth;
  return factory;
}

class OpenAIOAuthLanguageModel implements LanguageModelV4 {
  readonly specificationVersion = 'v4' as const;
  readonly provider = 'openai-oauth';
  readonly supportedUrls = {};
  private readonly responses: ResponsesClient;

  constructor(readonly modelId: string, auth: OpenAIOAuth) { this.responses = new ResponsesClient({ accessToken: () => auth.accessToken(), fetch: auth.requestFetch }); }

  async doGenerate(options: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> {
    const { instructions, input } = convertPrompt(options);
    const request = { model: this.modelId, input, ...(instructions ? { instructions } : {}), store: false, stream: true };
    const result = await this.responses.generate(request, options.abortSignal);
    return {
      content: result.text ? [{ type: 'text', text: result.text }] : [],
      finishReason: finishReason(result.terminal),
      usage: usageFor(result.terminal),
      warnings: unsupportedWarnings(options),
      request: { body: request },
      response: { id: result.terminal.id, headers: Object.fromEntries(result.headers.entries()) },
    };
  }

  async doStream(options: LanguageModelV4CallOptions): Promise<LanguageModelV4StreamResult> {
    const { instructions, input } = convertPrompt(options);
    const request = { model: this.modelId, input, ...(instructions ? { instructions } : {}), store: false, stream: true };
    const cancellation = new AbortController();
    let cancelled = false;
    let consumerCancelled = false;
    const cancel = () => { cancelled = true; cancellation.abort(); };
    let iterator: AsyncGenerator<Record<string, unknown>> | undefined;
    const onAbort = () => { cancel(); void iterator?.return?.(undefined); };
    options.abortSignal?.addEventListener('abort', onAbort, { once: true });
    if (options.abortSignal?.aborted) cancel();

    try {
      const signal = AbortSignal.any([cancellation.signal, ...(options.abortSignal ? [options.abortSignal] : [])]);
      const { headers, events } = await this.responses.stream(request, signal);
      const stream = new ReadableStream<LanguageModelV4StreamPart>({
        async start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: unsupportedWarnings(options) });
          const textIds = new Set<string>();
          let metadataSent = false;
          let completed = false;
          iterator = events;
          try {
            for await (const event of iterator) {
              if (cancelled) break;
              const terminal = responseFromEvent(event);
              if (!metadataSent && terminal) {
                controller.enqueue(responseMetadata(terminal));
                metadataSent = true;
              }
              if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
                const id = typeof event.item_id === 'string' ? event.item_id : 'text-0';
                if (!textIds.has(id)) { textIds.add(id); controller.enqueue({ type: 'text-start', id }); }
                controller.enqueue({ type: 'text-delta', id, delta: event.delta });
              }
              if (event.type === 'response.output_text.done' && typeof event.item_id === 'string' && textIds.delete(event.item_id)) controller.enqueue({ type: 'text-end', id: event.item_id });
              if (event.type === 'response.completed') {
                for (const id of textIds) controller.enqueue({ type: 'text-end', id });
                textIds.clear();
                const result = event.response as ResponseTerminal;
                controller.enqueue({ type: 'finish', usage: usageFor(result), finishReason: finishReason(result) });
                completed = true;
                break;
              }
              if (event.type === 'response.failed' || event.type === 'response.incomplete' || event.type === 'error') throw streamError(event, headers);
            }
            if (!cancelled && !completed) throw new OpenAIOAuthError('OpenAI stream ended before response.completed.', { requestId: headers.get('x-request-id') ?? undefined });
          } catch (error) {
            if (!cancelled) controller.enqueue({ type: 'error', error });
          } finally {
            options.abortSignal?.removeEventListener('abort', onAbort);
            if (!consumerCancelled) controller.close();
          }
        },
        async cancel() {
          consumerCancelled = true;
          cancel();
          await iterator?.return?.(undefined);
          options.abortSignal?.removeEventListener('abort', onAbort);
        },
      });
      return { stream, request: { body: request }, response: { headers: Object.fromEntries(headers.entries()) } };
    } catch (error) {
      options.abortSignal?.removeEventListener('abort', onAbort);
      throw error;
    }
  }
}

function responseFromEvent(event: Record<string, unknown>): ResponseTerminal | undefined {
  return typeof event.response === 'object' && event.response !== null ? event.response as ResponseTerminal : undefined;
}

function responseMetadata(response: ResponseTerminal): LanguageModelV4StreamPart {
  return {
    type: 'response-metadata',
    ...(response.id ? { id: response.id } : {}),
    ...(response.model ? { modelId: response.model } : {}),
    ...(typeof response.created_at === 'number' ? { timestamp: new Date(response.created_at * 1_000) } : {}),
  };
}

function finishReason(terminal: ResponseTerminal) {
  return { unified: terminal.status === 'incomplete' ? 'length' as const : 'stop' as const, raw: terminal.status };
}

function usageFor(terminal: ResponseTerminal) {
  const usage = terminal.usage;
  return {
    inputTokens: { total: usage?.input_tokens, noCache: usage?.input_tokens === undefined ? undefined : usage.input_tokens - (usage.input_tokens_details?.cached_tokens ?? 0), cacheRead: usage?.input_tokens_details?.cached_tokens, cacheWrite: undefined },
    outputTokens: { total: usage?.output_tokens, text: undefined, reasoning: usage?.output_tokens_details?.reasoning_tokens },
    ...(usage ? { raw: usage as never } : {}),
  };
}

function streamError(event: Record<string, unknown>, headers: Headers): OpenAIOAuthError {
  if (event.type === 'error') return new OpenAIOAuthError(String(event.message ?? 'OpenAI stream error.'), { code: typeof event.code === 'string' ? event.code : undefined, requestId: headers.get('x-request-id') ?? undefined });
  const failure = (event.response as { error?: { message?: string; code?: string; param?: string } } | undefined)?.error;
  return new OpenAIOAuthError(failure?.message ?? `OpenAI response ${event.type}.`, { code: failure?.code, param: failure?.param, requestId: headers.get('x-request-id') ?? undefined });
}

function convertPrompt(options: LanguageModelV4CallOptions): { instructions?: string; input: unknown[] } {
  const instructions: string[] = [];
  const input: unknown[] = [];
  for (const message of options.prompt) {
    if (message.role === 'system') { instructions.push(message.content); continue; }
    if (message.role !== 'user' && message.role !== 'assistant') throw new OpenAIOAuthError(`${message.role} messages are not supported in v0.1.`);
    const parts = message.content.map(part => {
      if (part.type !== 'text') throw new OpenAIOAuthError(`${part.type} input is not supported in v0.1.`);
      return { type: message.role === 'user' ? 'input_text' : 'output_text', text: part.text };
    });
    input.push({ role: message.role, content: parts });
  }
  return { ...(instructions.length ? { instructions: instructions.join('\n\n') } : {}), input };
}

function unsupportedWarnings(options: LanguageModelV4CallOptions): SharedV4Warning[] {
  const unsupported: Array<[string, unknown]> = [
    ['maxOutputTokens', options.maxOutputTokens], ['temperature', options.temperature], ['stopSequences', options.stopSequences],
    ['topP', options.topP], ['topK', options.topK], ['presencePenalty', options.presencePenalty], ['frequencyPenalty', options.frequencyPenalty],
    ['seed', options.seed], ['reasoning', options.reasoning && options.reasoning !== 'provider-default'], ['responseFormat', options.responseFormat && options.responseFormat.type !== 'text'],
    ['tools', options.tools], ['toolChoice', options.toolChoice && options.toolChoice.type !== 'auto'],
  ];
  return unsupported.filter(([, value]) => value !== undefined && value !== false).map(([feature]) => ({ type: 'unsupported', feature }));
}

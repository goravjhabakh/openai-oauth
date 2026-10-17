import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4GenerateResult, LanguageModelV4StreamPart, LanguageModelV4StreamResult, SharedV4Warning } from '@ai-sdk/provider';
import { OpenAIOAuth } from './auth.js';
import { OpenAIOAuthError, errorFromEvent } from './errors.js';
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
    const { request, warnings } = requestFor(this.modelId, options);
    const result = await this.responses.generate(request, options.abortSignal);
    return {
      content: result.text ? [{ type: 'text', text: result.text }] : [],
      finishReason: finishReason(result.terminal),
      usage: usageFor(result.terminal),
      warnings,
      request: { body: request },
      response: responseDetails(result.terminal, result.headers),
      providerMetadata: providerMetadata(result.terminal),
    };
  }

  async doStream(options: LanguageModelV4CallOptions): Promise<LanguageModelV4StreamResult> {
    const { request, warnings } = requestFor(this.modelId, options);
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
          controller.enqueue({ type: 'stream-start', warnings });
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
                controller.enqueue({ type: 'finish', usage: usageFor(result), finishReason: finishReason(result), providerMetadata: providerMetadata(result) });
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
  return errorFromEvent(event, headers.get('x-request-id') ?? undefined);
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

function requestFor(model: string, options: LanguageModelV4CallOptions): { request: Record<string, unknown>; warnings: SharedV4Warning[] } {
  const { instructions, input } = convertPrompt(options);
  const reasoning = reasoningOption(model, options.providerOptions?.['openai-oauth']);
  return {
    request: { model, input, ...(instructions ? { instructions } : {}), ...(reasoning ? { reasoning } : {}), store: false, stream: true },
    warnings: unsupportedWarnings(options, reasoning !== undefined),
  };
}

/** The only account-backed validated provider option is `{ effort: 'medium' }` on gpt-5.6-terra. */
export interface OpenAIOAuthProviderOptions { effort?: 'medium' }

function reasoningOption(model: string, value: unknown): OpenAIOAuthProviderOptions | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || Object.keys(value).some(key => key !== 'effort') || value.effort !== 'medium') {
    throw new OpenAIOAuthError("providerOptions['openai-oauth'] must be { effort: 'medium' }.");
  }
  if (model !== 'gpt-5.6-terra') throw new OpenAIOAuthError("providerOptions['openai-oauth'].effort is only validated for gpt-5.6-terra.");
  return { effort: 'medium' };
}

function unsupportedWarnings(options: LanguageModelV4CallOptions, hasProviderReasoning: boolean): SharedV4Warning[] {
  const unsupported: Array<[string, unknown]> = [
    ['maxOutputTokens', options.maxOutputTokens], ['temperature', options.temperature], ['stopSequences', options.stopSequences],
    ['topP', options.topP], ['topK', options.topK], ['presencePenalty', options.presencePenalty], ['frequencyPenalty', options.frequencyPenalty],
    ['seed', options.seed], ['reasoning', options.reasoning && options.reasoning !== 'provider-default'], ['responseFormat', options.responseFormat && options.responseFormat.type !== 'text'],
    ['tools', options.tools], ['toolChoice', options.toolChoice && options.toolChoice.type !== 'auto'], ['includeRawChunks', options.includeRawChunks],
  ];
  const warnings = unsupported.filter(([, value]) => value !== undefined && value !== false).map(([feature]) => ({ type: 'unsupported' as const, feature }));
  if (options.providerOptions?.['openai-oauth'] !== undefined && !hasProviderReasoning) warnings.push({ type: 'unsupported', feature: "providerOptions['openai-oauth']" });
  return warnings;
}

function responseDetails(terminal: ResponseTerminal, headers: Headers) {
  return { ...(terminal.id ? { id: terminal.id } : {}), ...(terminal.model ? { modelId: terminal.model } : {}), ...(typeof terminal.created_at === 'number' ? { timestamp: new Date(terminal.created_at * 1_000) } : {}), headers: Object.fromEntries(headers.entries()) };
}

function providerMetadata(terminal: ResponseTerminal) {
  const usage = terminal.usage;
  return { 'openai-oauth': {
    ...(terminal.status ? { terminalStatus: terminal.status } : {}),
    ...(usage ? { rawUsage: usage as unknown as Record<string, unknown> } : {}),
    ...(usage?.output_tokens_details?.reasoning_tokens !== undefined ? { reasoningTokensReported: true } : {}),
  } } as LanguageModelV4GenerateResult['providerMetadata'];
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }

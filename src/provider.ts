import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4Content, LanguageModelV4GenerateResult, LanguageModelV4StreamPart, LanguageModelV4StreamResult, SharedV4Warning } from '@ai-sdk/provider';
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
  /** The OAuth Responses route accepts externally hosted image and file URLs directly. */
  readonly supportedUrls = { '*/*': [/^https?:\/\//] };
  private readonly responses: ResponsesClient;

  constructor(readonly modelId: string, auth: OpenAIOAuth) { this.responses = new ResponsesClient({ accessToken: () => auth.accessToken(), fetch: auth.requestFetch }); }

  async doGenerate(options: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> {
    const { request, warnings } = requestFor(this.modelId, options);
    const result = await this.responses.generate(request, options.abortSignal);
    const content = contentFromEvents(result.events);
    return {
      content,
      finishReason: finishReason(result.terminal, content.some(item => item.type === 'tool-call')),
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
          const functionCalls = new Map<string, { callId: string; name: string; arguments: string }>();
          let hasFunctionCalls = false;
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
              if (event.type === 'response.output_item.added') {
                const item = event.item;
                if (isFunctionCall(item)) {
                  functionCalls.set(item.id, { callId: item.call_id, name: item.name, arguments: item.arguments });
                  controller.enqueue({ type: 'tool-input-start', id: item.call_id, toolName: item.name });
                }
              }
              if (event.type === 'response.function_call_arguments.delta' && typeof event.item_id === 'string' && typeof event.delta === 'string') {
                const call = functionCalls.get(event.item_id);
                if (call) { call.arguments += event.delta; controller.enqueue({ type: 'tool-input-delta', id: call.callId, delta: event.delta }); }
              }
              if (event.type === 'response.function_call_arguments.done' && typeof event.item_id === 'string' && typeof event.arguments === 'string') {
                const call = functionCalls.get(event.item_id);
                if (!call) throw new OpenAIOAuthError('OpenAI completed function-call arguments without a function-call item.');
                call.arguments = event.arguments;
                controller.enqueue({ type: 'tool-input-end', id: call.callId });
                controller.enqueue({ type: 'tool-call', toolCallId: call.callId, toolName: call.name, input: call.arguments });
                functionCalls.delete(event.item_id);
                hasFunctionCalls = true;
              }
              if (event.type === 'response.completed') {
                if (functionCalls.size) throw new OpenAIOAuthError('OpenAI completed with incomplete function-call arguments.');
                for (const id of textIds) controller.enqueue({ type: 'text-end', id });
                textIds.clear();
                const result = event.response as ResponseTerminal;
                controller.enqueue({ type: 'finish', usage: usageFor(result), finishReason: finishReason(result, hasFunctionCalls), providerMetadata: providerMetadata(result) });
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

function finishReason(terminal: ResponseTerminal, hasFunctionCall = false) {
  return { unified: terminal.status === 'incomplete' ? 'length' as const : hasFunctionCall ? 'tool-calls' as const : 'stop' as const, raw: terminal.status };
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

const V05_VALIDATED_MODEL = 'gpt-5.6-terra';

function convertPrompt(model: string, options: LanguageModelV4CallOptions): { instructions?: string; input: unknown[] } {
  const instructions: string[] = [];
  const input: unknown[] = [];
  for (const message of options.prompt) {
    if (message.role === 'system') { instructions.push(message.content); continue; }
    if (message.role === 'tool') {
      for (const part of message.content) input.push(functionOutput(part));
      continue;
    }
    let textParts: unknown[] = [];
    const flushText = () => {
      if (textParts.length) input.push({ role: message.role, content: textParts });
      textParts = [];
    };
    for (const part of message.content) {
      if (part.type === 'text') textParts.push({ type: message.role === 'user' ? 'input_text' : 'output_text', text: part.text });
      else if (message.role === 'user' && part.type === 'file') textParts.push(inputFile(model, part));
      else if (message.role === 'assistant' && part.type === 'tool-call') { flushText(); input.push(functionCall(part)); }
      else if (message.role === 'assistant' && part.type === 'tool-result') { flushText(); input.push(functionOutput(part)); }
      else throw new OpenAIOAuthError(`${part.type} input is not supported.`);
    }
    flushText();
  }
  return { ...(instructions.length ? { instructions: instructions.join('\n\n') } : {}), input };
}

function requestFor(model: string, options: LanguageModelV4CallOptions): { request: Record<string, unknown>; warnings: SharedV4Warning[] } {
  const { instructions, input } = convertPrompt(model, options);
  const reasoning = reasoningOption(model, options.providerOptions?.['openai-oauth']);
  const tools = functionTools(options.tools);
  const toolChoice = toolChoiceFor(options.toolChoice, tools);
  const text = structuredOutput(model, options.responseFormat);
  return {
    request: { model, input, ...(instructions ? { instructions } : {}), ...(reasoning ? { reasoning } : {}), ...(text ? { text } : {}), ...(tools.length ? { tools } : {}), ...(toolChoice ? { tool_choice: toolChoice } : {}), store: false, stream: true },
    warnings: unsupportedWarnings(options, reasoning !== undefined, tools.length),
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

function unsupportedWarnings(options: LanguageModelV4CallOptions, hasProviderReasoning: boolean, functionToolCount: number): SharedV4Warning[] {
  const unsupported: Array<[string, unknown]> = [
    ['maxOutputTokens', options.maxOutputTokens], ['temperature', options.temperature], ['stopSequences', options.stopSequences],
    ['topP', options.topP], ['topK', options.topK], ['presencePenalty', options.presencePenalty], ['frequencyPenalty', options.frequencyPenalty],
    ['seed', options.seed], ['reasoning', options.reasoning && options.reasoning !== 'provider-default'],
    ['tools', options.tools && (options.tools.length === 0 || functionToolCount !== options.tools.length) ? options.tools : undefined], ['includeRawChunks', options.includeRawChunks],
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

function structuredOutput(model: string, format: LanguageModelV4CallOptions['responseFormat']): Record<string, unknown> | undefined {
  if (!format || format.type === 'text') return undefined;
  if (model !== V05_VALIDATED_MODEL) throw new OpenAIOAuthError(`JSON-schema output is only validated for ${V05_VALIDATED_MODEL}.`);
  if (!format.schema || !isRecord(format.schema)) throw new OpenAIOAuthError('responseFormat JSON output requires an object JSON Schema.');
  if (format.name !== undefined && (!format.name.trim() || format.name.length > 64)) throw new OpenAIOAuthError('responseFormat.name must be a non-empty string of at most 64 characters.');
  if (format.description !== undefined && typeof format.description !== 'string') throw new OpenAIOAuthError('responseFormat.description must be a string.');
  let schema: unknown;
  try { schema = JSON.parse(JSON.stringify(format.schema)); }
  catch { throw new OpenAIOAuthError('responseFormat.schema must be JSON-serializable.'); }
  return { format: { type: 'json_schema', name: format.name ?? 'response', ...(format.description ? { description: format.description } : {}), schema, strict: true } };
}

function inputFile(model: string, part: { mediaType: string; filename?: string; data: unknown }): Record<string, unknown> {
  if (model !== V05_VALIDATED_MODEL) throw new OpenAIOAuthError(`Image and file input is only validated for ${V05_VALIDATED_MODEL}.`);
  if (!isRecord(part.data) || typeof part.data.type !== 'string') throw new OpenAIOAuthError('File input has invalid data.');
  const image = part.mediaType === 'image/png';
  if (part.mediaType.startsWith('image/') && !image) throw new OpenAIOAuthError(`Image media type '${part.mediaType}' is not validated; only image/png is supported.`);
  if (!image && part.mediaType !== 'text/plain') throw new OpenAIOAuthError(`File media type '${part.mediaType}' is not validated; only text/plain is supported.`);
  if (part.data.type === 'reference') throw new OpenAIOAuthError('Provider file references are not supported.');
  if (part.data.type === 'url') {
    const url = typeof part.data.originalUrl === 'string' ? part.data.originalUrl : part.data.url instanceof URL ? part.data.url.href : undefined;
    if (!url || !/^https?:\/\//i.test(url)) throw new OpenAIOAuthError('Only HTTP(S) file URLs are supported.');
    return image ? { type: 'input_image', image_url: url } : { type: 'input_file', file_url: url, ...(part.filename ? { filename: part.filename } : {}) };
  }
  if (part.data.type === 'text') {
    if (image) throw new OpenAIOAuthError('Images require base64 data or an HTTP(S) URL.');
    if (typeof part.data.text !== 'string') throw new OpenAIOAuthError('Inline file text must be a string.');
    return encodedFile(part, Buffer.from(part.data.text).toString('base64'));
  }
  if (part.data.type === 'data') {
    const value = part.data.data;
    const base64 = value instanceof Uint8Array ? Buffer.from(value).toString('base64') : typeof value === 'string' ? value : undefined;
    if (!base64 || !isBase64(base64)) throw new OpenAIOAuthError('Inline file data must be a non-empty base64 string or Uint8Array.');
    return encodedFile(part, base64);
  }
  throw new OpenAIOAuthError(`File data form '${part.data.type}' is not supported.`);
}

function encodedFile(part: { mediaType: string; filename?: string }, base64: string): Record<string, unknown> {
  const dataUrl = `data:${part.mediaType};base64,${base64}`;
  return part.mediaType === 'image/png'
    ? { type: 'input_image', image_url: dataUrl }
    : { type: 'input_file', file_data: dataUrl, ...(part.filename ? { filename: part.filename } : {}) };
}

function isBase64(value: string) { return value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value); }

function functionTools(tools: LanguageModelV4CallOptions['tools']): Array<Record<string, unknown>> {
  if (!tools) return [];
  return tools.filter((tool): tool is Extract<typeof tool, { type: 'function' }> => tool.type === 'function').map(tool => ({ type: 'function', name: tool.name, ...(tool.description ? { description: tool.description } : {}), parameters: tool.inputSchema }));
}

function toolChoiceFor(choice: LanguageModelV4CallOptions['toolChoice'], tools: Array<Record<string, unknown>>): unknown {
  if (!choice || choice.type === 'auto') return choice?.type === 'auto' && tools.length ? 'auto' : undefined;
  if (!tools.length) throw new OpenAIOAuthError('toolChoice requires at least one supported function tool.');
  if (choice.type === 'none' || choice.type === 'required') return choice.type;
  if (choice.type === 'tool') {
    if (!tools.some(tool => tool.name === choice.toolName)) throw new OpenAIOAuthError(`toolChoice references unknown function tool '${choice.toolName}'.`);
    return { type: 'function', name: choice.toolName };
  }
  throw new OpenAIOAuthError('Unsupported toolChoice.');
}

function functionCall(part: { toolCallId: string; toolName: string; input: unknown }): Record<string, unknown> {
  return { type: 'function_call', call_id: part.toolCallId, name: part.toolName, arguments: JSON.stringify(part.input) };
}

function functionOutput(part: unknown): Record<string, unknown> {
  if (!isRecord(part) || part.type !== 'tool-result' || typeof part.toolCallId !== 'string') throw new OpenAIOAuthError('Only function-tool results are supported.');
  const output = part.output as { type?: string; value?: unknown };
  if (output.type === 'text' && typeof output.value === 'string') return { type: 'function_call_output', call_id: part.toolCallId, output: output.value };
  if (output.type === 'json') return { type: 'function_call_output', call_id: part.toolCallId, output: JSON.stringify(output.value) };
  throw new OpenAIOAuthError('Only text and JSON function-tool results are supported.');
}

function isFunctionCall(value: unknown): value is { id: string; type: 'function_call'; call_id: string; name: string; arguments: string } {
  return isRecord(value) && value.type === 'function_call' && typeof value.id === 'string' && typeof value.call_id === 'string' && typeof value.name === 'string' && typeof value.arguments === 'string';
}

function contentFromEvents(events: Record<string, unknown>[]): LanguageModelV4Content[] {
  const content: LanguageModelV4Content[] = [];
  const text = new Map<string, { type: 'text'; text: string }>();
  const calls = new Map<string, { callId: string; name: string; arguments: string }>();
  for (const event of events) {
    if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
      const id = typeof event.item_id === 'string' ? event.item_id : 'text-0';
      let item = text.get(id);
      if (!item) { item = { type: 'text', text: '' }; text.set(id, item); content.push(item); }
      item.text += event.delta;
    }
    if (event.type === 'response.output_item.added' && isFunctionCall(event.item)) calls.set(event.item.id, { callId: event.item.call_id, name: event.item.name, arguments: event.item.arguments });
    if (event.type === 'response.function_call_arguments.delta' && typeof event.item_id === 'string' && typeof event.delta === 'string') {
      const call = calls.get(event.item_id);
      if (call) call.arguments += event.delta;
    }
    if (event.type === 'response.function_call_arguments.done' && typeof event.item_id === 'string' && typeof event.arguments === 'string') {
      const call = calls.get(event.item_id);
      if (!call) throw new OpenAIOAuthError('OpenAI completed function-call arguments without a function-call item.');
      call.arguments = event.arguments;
      content.push({ type: 'tool-call', toolCallId: call.callId, toolName: call.name, input: call.arguments });
      calls.delete(event.item_id);
    }
  }
  if (calls.size) throw new OpenAIOAuthError('OpenAI completed with incomplete function-call arguments.');
  return content;
}

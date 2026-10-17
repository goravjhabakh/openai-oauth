import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4GenerateResult, SharedV4Warning } from '@ai-sdk/provider';
import { OpenAIOAuth } from './auth.js';
import { OpenAIOAuthError } from './errors.js';
import { ResponsesClient } from './responses.js';
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
    const usage = result.terminal.usage;
    return {
      content: result.text ? [{ type: 'text', text: result.text }] : [],
      finishReason: { unified: result.terminal.status === 'incomplete' ? 'length' : 'stop', raw: result.terminal.status },
      usage: {
        inputTokens: { total: usage?.input_tokens, noCache: usage?.input_tokens === undefined ? undefined : usage.input_tokens - (usage.input_tokens_details?.cached_tokens ?? 0), cacheRead: usage?.input_tokens_details?.cached_tokens, cacheWrite: undefined },
        outputTokens: { total: usage?.output_tokens, text: undefined, reasoning: usage?.output_tokens_details?.reasoning_tokens },
        ...(usage ? { raw: usage as never } : {}),
      },
      warnings: unsupportedWarnings(options),
      request: { body: request },
      response: { id: result.terminal.id, headers: Object.fromEntries(result.headers.entries()) },
    };
  }

  async doStream(): Promise<never> {
    throw new OpenAIOAuthError('streamText() is not supported in v0.1; use generateText().');
  }
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

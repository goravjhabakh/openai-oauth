import { describe, expect, it } from 'vitest';
import { generateText, streamText } from 'ai';
import { FileCredentialStore, createOpenAIOAuth } from '../src/index.js';
import { parseSse } from '../src/responses.js';
import { responseError } from '../src/errors.js';

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of stream) values.push(value);
  return values;
}

describe('Responses SSE', () => {
  it('classifies structured admission errors without exposing authorization data', async () => {
    const error = await responseError(new Response(JSON.stringify({ error: { message: 'Bearer secret-token is rejected', code: 'subscription_sharing_usage_unavailable', param: 'reasoning' } }), { status: 503, headers: { 'x-request-id': 'req_1' } }));
    expect(error).toMatchObject({ options: { status: 503, code: 'subscription_sharing_usage_unavailable', param: 'reasoning', requestId: 'req_1', retry: 'backoff' } });
    expect(error.message).not.toContain('secret-token');
  });

  it('parses split SSE events', async () => {
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"He'));
      controller.enqueue(new TextEncoder().encode('llo"}\n\ndata: {"type":"response.completed","response":{}}\n\n'));
      controller.close();
    } });
    const events = [];
    for await (const event of parseSse(stream)) events.push(event);
    expect(events).toHaveLength(2);
    expect(events[0].delta).toBe('Hello');
  });

  it('aggregates required streaming Responses output for generateText', async () => {
    const store = new FileCredentialStore(`${process.env.TEMP ?? '.'}/openai-oauth-test-${crypto.randomUUID()}.json`);
    await store.save('test', { clientId: 'client', hostId: 'host', identity: { issuer: 'https://auth.openai.com', sub: 'sub' }, accessToken: 'access', refreshToken: 'refresh', idToken: 'id', expiresAt: Date.now() + 3_600_000, scopes: ['chatgpt.tokens.use.direct'] });
    let requestBody: unknown;
    const provider = createOpenAIOAuth({ agentName: 'Test app', hostId: 'host', credentialStore: store, credentialKey: 'test', openAuthorizationUrl() {}, fetch: async (url, init) => {
      expect(String(url)).toBe('https://api.openai.com/v1/responses');
      requestBody = JSON.parse(String(init?.body));
      return new Response('data: {"type":"response.output_text.delta","delta":"Hello"}\n\ndata: {"type":"response.completed","response":{"id":"resp_1","status":"completed","usage":{"input_tokens":3,"output_tokens":1}}}\n\n', { headers: { 'content-type': 'text/event-stream', 'x-request-id': 'req_1' } });
    } });
    const result = await generateText({ model: provider('model-slug'), prompt: 'Hi' });
    expect(result.text).toBe('Hello');
    expect(requestBody).toEqual({ model: 'model-slug', input: [{ role: 'user', content: [{ type: 'input_text', text: 'Hi' }] }], store: false, stream: true });
  });

  it('forwards only the validated reasoning option and preserves terminal metadata', async () => {
    const store = new FileCredentialStore(`${process.env.TEMP ?? '.'}/openai-oauth-test-${crypto.randomUUID()}.json`);
    await store.save('test', { clientId: 'client', hostId: 'host', identity: { issuer: 'https://auth.openai.com', sub: 'sub' }, accessToken: 'access', refreshToken: 'refresh', idToken: 'id', expiresAt: Date.now() + 3_600_000, scopes: ['chatgpt.tokens.use.direct'] });
    let body: Record<string, unknown> | undefined;
    const provider = createOpenAIOAuth({ agentName: 'Test app', hostId: 'host', credentialStore: store, credentialKey: 'test', openAuthorizationUrl() {}, fetch: async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return new Response('data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","model":"gpt-5.6-terra","created_at":1,"usage":{"input_tokens":3,"output_tokens":1,"output_tokens_details":{"reasoning_tokens":0}}}}\n\n');
    } });
    const result = await provider('gpt-5.6-terra').doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }], providerOptions: { 'openai-oauth': { effort: 'medium' } } });
    expect(body).toMatchObject({ reasoning: { effort: 'medium' }, store: false, stream: true });
    expect(result.providerMetadata).toMatchObject({ 'openai-oauth': { terminalStatus: 'completed', reasoningTokensReported: true } });
    await expect(provider('gpt-5.6-sol').doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }], providerOptions: { 'openai-oauth': { effort: 'medium' } } })).rejects.toThrow('only validated');
  });

  it('returns matching warnings for generate and stream requests', async () => {
    const store = new FileCredentialStore(`${process.env.TEMP ?? '.'}/openai-oauth-test-${crypto.randomUUID()}.json`);
    await store.save('test', { clientId: 'client', hostId: 'host', identity: { issuer: 'https://auth.openai.com', sub: 'sub' }, accessToken: 'access', refreshToken: 'refresh', idToken: 'id', expiresAt: Date.now() + 3_600_000, scopes: ['chatgpt.tokens.use.direct'] });
    const provider = createOpenAIOAuth({ agentName: 'Test app', hostId: 'host', credentialStore: store, credentialKey: 'test', openAuthorizationUrl() {}, fetch: async () => new Response('data: {"type":"response.completed","response":{"status":"completed"}}\n\n') });
    const options = { prompt: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'Hi' }] }], temperature: 0.4, maxOutputTokens: 10, tools: [] };
    const generated = await provider('model').doGenerate(options);
    const streamed = await provider('model').doStream(options);
    expect(generated.warnings).toEqual([{ type: 'unsupported', feature: 'maxOutputTokens' }, { type: 'unsupported', feature: 'temperature' }, { type: 'unsupported', feature: 'tools' }]);
    expect((await streamed.stream.getReader().read()).value).toEqual({ type: 'stream-start', warnings: generated.warnings });
  });

  it('maps Responses SSE events for streamText', async () => {
    const store = new FileCredentialStore(`${process.env.TEMP ?? '.'}/openai-oauth-test-${crypto.randomUUID()}.json`);
    await store.save('test', { clientId: 'client', hostId: 'host', identity: { issuer: 'https://auth.openai.com', sub: 'sub' }, accessToken: 'access', refreshToken: 'refresh', idToken: 'id', expiresAt: Date.now() + 3_600_000, scopes: ['chatgpt.tokens.use.direct'] });
    const provider = createOpenAIOAuth({ agentName: 'Test app', hostId: 'host', credentialStore: store, credentialKey: 'test', openAuthorizationUrl() {}, fetch: async () => new Response([
      'data: {"type":"response.created","response":{"id":"resp_1","model":"model-slug","created_at":1}}\n\n',
      'data: {"type":"response.output_text.delta","item_id":"msg_1","delta":"Hello"}\n\n',
      'data: {"type":"response.output_text.delta","item_id":"msg_1","delta":" world"}\n\n',
      'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","usage":{"input_tokens":3,"output_tokens":2}}}\n\n',
    ].join(''), { headers: { 'content-type': 'text/event-stream', 'x-request-id': 'req_1' } }) });

    const result = streamText({ model: provider('model-slug'), prompt: 'Hi' });
    expect(await collect(result.textStream)).toEqual(['Hello', ' world']);
    await expect(result.text).resolves.toBe('Hello world');
    await expect(result.usage).resolves.toMatchObject({ inputTokens: 3, outputTokens: 2 });
    await expect(result.response).resolves.toMatchObject({ id: 'resp_1', modelId: 'model-slug' });
  });

  it('reports a premature stream end as a stream error', async () => {
    const store = new FileCredentialStore(`${process.env.TEMP ?? '.'}/openai-oauth-test-${crypto.randomUUID()}.json`);
    await store.save('test', { clientId: 'client', hostId: 'host', identity: { issuer: 'https://auth.openai.com', sub: 'sub' }, accessToken: 'access', refreshToken: 'refresh', idToken: 'id', expiresAt: Date.now() + 3_600_000, scopes: ['chatgpt.tokens.use.direct'] });
    const errors: unknown[] = [];
    const provider = createOpenAIOAuth({ agentName: 'Test app', hostId: 'host', credentialStore: store, credentialKey: 'test', openAuthorizationUrl() {}, fetch: async () => new Response('data: {"type":"response.output_text.delta","item_id":"msg_1","delta":"Hello"}\n\n') });

    const result = streamText({ model: provider('model-slug'), prompt: 'Hi', onError: ({ error }) => errors.push(error) });
    await collect(result.stream);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ message: 'OpenAI stream ended before response.completed.' });
  });

  it('cancels the upstream response when the consumer cancels', async () => {
    const store = new FileCredentialStore(`${process.env.TEMP ?? '.'}/openai-oauth-test-${crypto.randomUUID()}.json`);
    await store.save('test', { clientId: 'client', hostId: 'host', identity: { issuer: 'https://auth.openai.com', sub: 'sub' }, accessToken: 'access', refreshToken: 'refresh', idToken: 'id', expiresAt: Date.now() + 3_600_000, scopes: ['chatgpt.tokens.use.direct'] });
    let bodyCancelled = false;
    const provider = createOpenAIOAuth({ agentName: 'Test app', hostId: 'host', credentialStore: store, credentialKey: 'test', openAuthorizationUrl() {}, fetch: async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta","item_id":"msg_1","delta":"Hello"}\n\n')); },
      cancel() { bodyCancelled = true; },
    })) });

    const result = await provider('model-slug').doStream({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }] });
    const reader = result.stream.getReader();
    await reader.read(); // stream-start
    expect(await reader.read()).toMatchObject({ value: { type: 'text-start', id: 'msg_1' }, done: false });
    expect(await reader.read()).toMatchObject({ value: { type: 'text-delta', id: 'msg_1', delta: 'Hello' }, done: false });
    await reader.cancel();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(bodyCancelled).toBe(true);
  });
});

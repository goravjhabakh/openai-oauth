import { describe, expect, it } from 'vitest';
import { generateText } from 'ai';
import { FileCredentialStore, createOpenAIOAuth } from '../src/index.js';
import { parseSse } from '../src/responses.js';

describe('Responses SSE', () => {
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
});

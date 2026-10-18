import { generateText, streamText, type LanguageModel } from 'ai';
import {
  FileCredentialStore,
  OpenAIOAuthError,
  createOpenAIOAuth,
  type CredentialStore,
  type OpenAIModelCatalogEntry,
  type OAuthCredentials,
} from '@gorav/openai-oauth';

const store: CredentialStore = new FileCredentialStore('.private/openai-oauth.json');
const credentials: OAuthCredentials = {
  clientId: 'fixture-client', hostId: 'urn:uuid:fixture-host', identity: { issuer: 'https://auth.openai.com', sub: 'fixture' },
  accessToken: 'fixture-access', refreshToken: 'fixture-refresh', idToken: 'fixture-id', expiresAt: Date.now() + 3_600_000, scopes: ['chatgpt.tokens.use.direct'],
};
await store.save('default', credentials);

const provider = createOpenAIOAuth({
  agentName: 'Packed consumer fixture',
  hostId: 'urn:uuid:fixture-host',
  credentialStore: store,
  credentialKey: 'default',
  openAuthorizationUrl: async () => {},
  fetch: async (url) => {
    if (String(url).endsWith('/models')) return Response.json({ models: [{ slug: 'fixture-model', display_name: 'Fixture model', visibility: 'list' }] });
    return new Response('data: {"type":"response.output_text.delta","item_id":"message_1","delta":"hello"}\n\ndata: {"type":"response.completed","response":{"id":"response_1","status":"completed","model":"fixture-model","usage":{"input_tokens":1,"output_tokens":1}}}\n\n', { headers: { 'content-type': 'text/event-stream' } });
  },
});

const catalog: OpenAIModelCatalogEntry[] = await provider.auth.listModelCatalog();
const model: LanguageModel = provider.languageModel(catalog[0].id);
const generated = await generateText({ model, prompt: 'Hello' });
const streamed = streamText({ model, prompt: 'Hello' });
let streamedText = '';
for await (const delta of streamed.textStream) streamedText += delta;
if (generated.text !== 'hello' || streamedText !== 'hello') throw new Error('Packed provider fixture did not generate expected text.');

const error = new OpenAIOAuthError('fixture', { status: 400, code: 'fixture', retry: 'none' });
if (error.status !== 400 || error.code !== 'fixture') throw new Error('Public error fields are unavailable.');
console.log('Packed consumer fixture passed.');

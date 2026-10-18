import { describe, expect, it } from 'vitest';
import { createOpenAIOAuth, FileCredentialStore, OpenAIOAuth, OpenAIOAuthError } from '../src/index.js';

describe('public configuration and errors', () => {
  const validUuidHostId = 'urn:uuid:6ba7b810-9dad-41d1-80b4-00c04fd430c8';
  const validJwkThumbprintHostId = 'urn:ietf:params:oauth:jwk-thumbprint:sha-256:AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_';
  const options = { agentName: 'Consumer app', hostId: validUuidHostId, credentialStore: new FileCredentialStore(`${process.env.TEMP ?? '.'}/openai-oauth-test-${crypto.randomUUID()}.json`), credentialKey: 'default', openAuthorizationUrl() {} };

  it('exposes the documented provider shape', () => {
    const provider = createOpenAIOAuth(options);
    expect(provider.languageModel).toBe(provider);
    expect(provider.auth).toBeInstanceOf(OpenAIOAuth);
    expect(provider('a-model').provider).toBe('openai-oauth');
  });

  it.each([validUuidHostId, validJwkThumbprintHostId])('accepts a supported host ID', hostId => {
    expect(() => createOpenAIOAuth({ ...options, hostId })).not.toThrow();
  });

  it.each([
    [{ ...options, agentName: '  ' }, 'agentName'],
    [{ ...options, hostId: '' }, 'hostId'],
    [{ ...options, hostId: '6ba7b810-9dad-41d1-80b4-00c04fd430c8' }, 'urn:uuid:'],
    [{ ...options, hostId: 'urn:uuid:not-a-uuid' }, 'hostId'],
    [{ ...options, hostId: 'urn:ietf:params:oauth:jwk-thumbprint:' }, 'hostId'],
    [{ ...options, credentialKey: '' }, 'credentialKey'],
    [{ ...options, openAuthorizationUrl: undefined as never }, 'openAuthorizationUrl'],
  ])('rejects invalid setup at the public boundary', (invalid, field) => {
    expect(() => createOpenAIOAuth(invalid)).toThrow(field);
  });

  it('makes the documented error fields directly available', () => {
    const error = new OpenAIOAuthError('test', { status: 429, code: 'limited', param: 'model', requestId: 'req_1', retry: 'backoff' });
    expect(error).toMatchObject({ name: 'OpenAIOAuthError', status: 429, code: 'limited', param: 'model', requestId: 'req_1', retry: 'backoff' });
  });

  it('does not overstate model-specific capability evidence', async () => {
    const authenticatedStore = new FileCredentialStore(`${process.env.TEMP ?? '.'}/openai-oauth-test-${crypto.randomUUID()}.json`);
    await authenticatedStore.save('default', { clientId: 'client', hostId: validUuidHostId, identity: { issuer: 'https://auth.openai.com', sub: 'subject' }, accessToken: 'access', refreshToken: 'refresh', idToken: 'id', expiresAt: Date.now() + 3_600_000, scopes: ['chatgpt.tokens.use.direct'] });
    const provider = createOpenAIOAuth({ ...options, credentialStore: authenticatedStore, fetch: async () => Response.json({ models: [
      { slug: 'other-visible-model', display_name: 'Other', visibility: 'list' },
      { slug: 'gpt-5.6-terra', display_name: 'Validated', visibility: 'list' },
    ] }) });
    const [other, validated] = await provider.auth.listModelCatalog();
    expect(other.capabilities).toMatchObject({ text: 'advertised', streaming: 'advertised', tools: 'unknown', jsonSchema: 'unknown' });
    expect(validated.capabilities).toMatchObject({ tools: 'validated', reasoning: 'validated', images: 'validated', files: 'validated', jsonSchema: 'validated', detailedUsage: 'validated' });
  });
});

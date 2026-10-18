import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { FileCredentialStore } from '../src/index.js';

describe('FileCredentialStore', () => {
  it('persists and removes credential records', async () => {
    const path = join(tmpdir(), `openai-oauth-${crypto.randomUUID()}.json`);
    const store = new FileCredentialStore(path);
    await store.save('account', { clientId: 'client', hostId: 'host', identity: { issuer: 'issuer', sub: 'subject' }, accessToken: 'access', refreshToken: 'refresh', idToken: 'id', expiresAt: 1, scopes: [] });
    expect((await store.load('account'))?.accessToken).toBe('access');
    expect(JSON.parse(await readFile(path, 'utf8')).account.clientId).toBe('client');
    await store.delete('account');
    expect(await store.load('account')).toBeNull();
  });

  it('does not overwrite malformed credential JSON', async () => {
    const path = join(tmpdir(), `openai-oauth-${crypto.randomUUID()}.json`);
    await writeFile(path, '{not json');
    const store = new FileCredentialStore(path);
    await expect(store.load('account')).rejects.toThrow('Credential store is corrupt');
    expect(await readFile(path, 'utf8')).toBe('{not json');
  });
});

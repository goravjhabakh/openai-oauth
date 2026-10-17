import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { jwtVerify, createRemoteJWKSet } from 'jose';
import type { CredentialStore, OAuthCredentials, OpenAIModel, OpenAIModelCatalogEntry } from './types.js';
import { OpenAIOAuthError, responseError } from './errors.js';

const AUTH_BASE = 'https://auth.openai.com';
const API_BASE = 'https://api.openai.com/v1';
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const jwks = createRemoteJWKSet(new URL(`${AUTH_BASE}/.well-known/jwks.json`));

export interface OpenAIOAuthOptions {
  agentName: string;
  hostId: string;
  credentialStore: CredentialStore;
  credentialKey: string;
  openAuthorizationUrl(url: string): void | Promise<void>;
  fetch?: typeof fetch;
}

export class OpenAIOAuth {
  readonly requestFetch: typeof fetch;
  private refreshPromise: Promise<string> | undefined;

  constructor(private readonly options: OpenAIOAuthOptions) {
    if (!options.agentName || !options.hostId) throw new Error('agentName and hostId are required.');
    this.requestFetch = options.fetch ?? globalThis.fetch;
  }

  async signIn(): Promise<OAuthCredentials> {
    const callback = await createCallbackServer();
    const state = randomValue();
    const nonce = randomValue();
    const verifier = randomValue();
    const challenge = base64url(createHash('sha256').update(verifier).digest());
    try {
      await callback.start();
      const existing = await this.options.credentialStore.load(this.options.credentialKey);
      const authorization = new URL(`${AUTH_BASE}/api/accounts/authorize`);
      authorization.search = new URLSearchParams({
        client_id: existing?.clientId ?? 'dynamic_agent_client',
        agent_name_hint: this.options.agentName,
        ext_agent_host_id: this.options.hostId,
        response_type: 'code', redirect_uri: callback.redirectUri, scope: SCOPES,
        resource: API_BASE, state, nonce, code_challenge_method: 'S256', code_challenge: challenge,
      }).toString();
      if (existing?.idToken) authorization.searchParams.set('id_token_hint', existing.idToken);
      await this.options.openAuthorizationUrl(authorization.toString());
      const params = await callback.waitForCallback();
      if (params.get('state') !== state) throw new OpenAIOAuthError('OAuth callback state did not match.');
      if (params.get('error')) throw new OpenAIOAuthError(`OAuth authorization failed: ${params.get('error_description') ?? params.get('error')}`);
      const code = params.get('code');
      const clientId = existing?.clientId ?? params.get('client_id');
      if (!code || !clientId || clientId === 'dynamic_agent_client') throw new OpenAIOAuthError('OAuth callback did not include an authorization code and issued client ID.');
      const tokens = await this.token({ grant_type: 'authorization_code', code, client_id: clientId, code_verifier: verifier, redirect_uri: callback.redirectUri, resource: API_BASE });
      const credentials = await this.credentialsFromToken(tokens, clientId, nonce, existing);
      await this.options.credentialStore.save(this.options.credentialKey, credentials);
      return credentials;
    } finally { callback.close(); }
  }

  async accessToken(): Promise<string> {
    if (!this.refreshPromise) this.refreshPromise = this.accessTokenInner().finally(() => { this.refreshPromise = undefined; });
    return this.refreshPromise;
  }

  async signOut(): Promise<void> {
    const credentials = await this.options.credentialStore.load(this.options.credentialKey);
    if (!credentials) return;
    const response = await this.requestFetch(`${AUTH_BASE}/api/accounts/oauth/revoke`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: credentials.refreshToken, token_type_hint: 'refresh_token', client_id: credentials.clientId }),
    });
    if (!response.ok) throw await responseError(response);
    await this.options.credentialStore.delete(this.options.credentialKey);
  }

  async listModels(): Promise<OpenAIModel[]> {
    return (await this.listModelCatalog()).map(({ id, name }) => ({ id, name }));
  }

  async listModelCatalog(): Promise<OpenAIModelCatalogEntry[]> {
    const response = await this.requestFetch(`${API_BASE}/models`, { headers: { authorization: `Bearer ${await this.accessToken()}` } });
    if (!response.ok) throw await responseError(response);
    const body = await response.json() as { models?: Array<{ slug?: string; display_name?: string; visibility?: string; capabilities?: unknown }> };
    return (body.models ?? []).filter(model => model.visibility === 'list' && model.slug).map(model => ({
      id: model.slug!, name: model.display_name ?? model.slug!,
      capabilities: modelCapabilities(model.slug!),
      ...(isRecord(model.capabilities) ? { advertisedCapabilities: model.capabilities } : {}),
    }));
  }

  private async accessTokenInner(): Promise<string> {
    const credentials = await this.options.credentialStore.load(this.options.credentialKey);
    if (!credentials) throw new OpenAIOAuthError('Not signed in. Call signIn() before using this provider.');
    if (credentials.expiresAt > Date.now() + 60_000) return credentials.accessToken;
    try {
      const tokens = await this.token({ grant_type: 'refresh_token', refresh_token: credentials.refreshToken, client_id: credentials.clientId, resource: API_BASE });
      const updated = await this.credentialsFromToken(tokens, credentials.clientId, undefined, credentials);
      await this.options.credentialStore.save(this.options.credentialKey, updated);
      return updated.accessToken;
    } catch (error) {
      if (error instanceof OpenAIOAuthError && ['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused'].includes(error.options.code ?? '')) {
        await this.options.credentialStore.delete(this.options.credentialKey);
      }
      throw error;
    }
  }

  private async token(params: Record<string, string>): Promise<TokenResponse> {
    const response = await this.requestFetch(`${AUTH_BASE}/api/accounts/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) });
    if (!response.ok) throw await responseError(response);
    return await response.json() as TokenResponse;
  }

  private async credentialsFromToken(tokens: TokenResponse, clientId: string, nonce: string | undefined, previous?: OAuthCredentials | null): Promise<OAuthCredentials> {
    if (!tokens.access_token || !tokens.refresh_token || !tokens.expires_in) throw new OpenAIOAuthError('OAuth token response is missing required tokens.');
    const idToken = tokens.id_token ?? previous?.idToken;
    if (!idToken) throw new OpenAIOAuthError('OAuth token response is missing an ID token.');
    const verified = await jwtVerify(idToken, jwks, { issuer: AUTH_BASE, audience: clientId, ...(nonce ? { nonce } : {}) });
    const scopes = tokens.scope ? tokens.scope.split(' ').filter(Boolean) : (previous?.scopes ?? []);
    if (!scopes.includes('chatgpt.tokens.use.direct')) throw new OpenAIOAuthError('The OAuth grant does not authorize direct ChatGPT plan usage.');
    if (typeof verified.payload.sub !== 'string') throw new OpenAIOAuthError('Validated ID token has no subject.');
    return { clientId, hostId: this.options.hostId, identity: { issuer: AUTH_BASE, sub: verified.payload.sub, email: typeof verified.payload.email === 'string' ? verified.payload.email : undefined }, accessToken: tokens.access_token, refreshToken: tokens.refresh_token, idToken, expiresAt: Date.now() + tokens.expires_in * 1000, scopes, earliestRefreshAt: tokens.earliest_refresh_at, };
  }
}

function modelCapabilities(id: string): OpenAIModelCatalogEntry['capabilities'] {
  return {
    route: {
      text: true, mandatoryStreaming: true, nonStreamingHttp: false, filesUpload: false, audioVideo: false,
      imageGeneration: false, fileSearch: false, codeInterpreter: false, computerUse: false, hostedMcp: false,
      toolSearch: false, persistentResponses: false,
    },
    text: 'validated', streaming: 'validated', nonStreamingHttp: 'advertised',
    filesUpload: 'advertised', audioVideo: 'advertised', imageGeneration: 'advertised', fileSearch: 'advertised',
    codeInterpreter: 'advertised', computerUse: 'advertised', hostedMcp: 'advertised', toolSearch: 'advertised',
    persistentResponses: 'advertised', reasoning: id === 'gpt-5.6-terra' ? 'validated' : 'unknown',
    tools: 'unknown', images: 'unknown', files: 'unknown', webSearch: 'unknown', jsonSchema: 'unknown', detailedUsage: 'unknown',
  };
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }

interface TokenResponse { access_token: string; refresh_token: string; id_token?: string; expires_in: number; scope?: string; earliest_refresh_at?: number }
function randomValue() { return base64url(randomBytes(32)); }
function base64url(value: Uint8Array) { return Buffer.from(value).toString('base64url'); }

function createCallbackServer() {
  let resolve: ((value: URLSearchParams) => void) | undefined;
  let reject: ((reason: Error) => void) | undefined;
  const result = new Promise<URLSearchParams>((res, rej) => { resolve = res; reject = rej; });
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/auth/callback') { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end('Sign-in complete. You can close this window.');
    resolve?.(url.searchParams);
  });
  return {
    get redirectUri() { const address = server.address(); if (!address || typeof address === 'string') throw new Error('OAuth callback server did not start.'); return `http://127.0.0.1:${address.port}/auth/callback`; },
    async start() { await new Promise<void>((res, rej) => server.listen(0, '127.0.0.1', res).once('error', rej)); },
    async waitForCallback() { return result; },
    close() { server.close(); reject?.(new Error('OAuth callback server closed.')); },
  };
}

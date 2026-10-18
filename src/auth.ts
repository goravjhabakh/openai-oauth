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
    validateOptions(options);
    this.requestFetch = options.fetch ?? globalThis.fetch;
  }

  async signIn(): Promise<OAuthCredentials> {
    const callback = await createCallbackServer();
    let callbackResult: CallbackResult | undefined;
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
      callbackResult = await callback.waitForCallback();
      const params = callbackResult.params;
      if (params.get('state') !== state) throw new OpenAIOAuthError('OAuth callback state did not match.');
      if (params.get('error')) throw new OpenAIOAuthError(`OAuth authorization failed: ${params.get('error_description') ?? params.get('error')}`);
      const code = params.get('code');
      const clientId = existing?.clientId ?? params.get('client_id');
      if (!code || !clientId || clientId === 'dynamic_agent_client') throw new OpenAIOAuthError('OAuth callback did not include an authorization code and issued client ID.');
      const tokens = await this.token({ grant_type: 'authorization_code', code, client_id: clientId, code_verifier: verifier, redirect_uri: callback.redirectUri, resource: API_BASE });
      const credentials = await this.credentialsFromToken(tokens, clientId, nonce, existing);
      await this.options.credentialStore.save(this.options.credentialKey, credentials);
      callbackResult.respond('success');
      return credentials;
    } catch (error) {
      // The browser must not be told that sign-in succeeded until the callback
      // has passed every local validation step and credentials are durable.
      callbackResult?.respond('error');
      throw error;
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

function validateOptions(options: OpenAIOAuthOptions): void {
  if (typeof options.agentName !== 'string' || !options.agentName.trim()) {
    throw new OpenAIOAuthError('agentName must be a non-empty name for the consuming application.');
  }
  if (typeof options.hostId !== 'string' || !isSupportedHostId(options.hostId)) {
    throw new OpenAIOAuthError(
      'hostId must be a persisted urn:uuid:<UUIDv4> or urn:ietf:params:oauth:jwk-thumbprint:<value> identifier owned by the application. Bare UUIDs are not supported; prefix UUIDs with urn:uuid:.',
      { code: 'invalid_host_id', param: 'hostId' },
    );
  }
  if (typeof options.credentialKey !== 'string' || !options.credentialKey.trim()) {
    throw new OpenAIOAuthError('credentialKey must be a non-empty credential-store record key.');
  }
  if (!options.credentialStore || typeof options.credentialStore.load !== 'function' || typeof options.credentialStore.save !== 'function' || typeof options.credentialStore.delete !== 'function') {
    throw new OpenAIOAuthError('credentialStore must provide async load, save, and delete methods.');
  }
  if (typeof options.openAuthorizationUrl !== 'function') {
    throw new OpenAIOAuthError('openAuthorizationUrl must open the OAuth consent URL in a local browser.');
  }
  if (options.fetch !== undefined && typeof options.fetch !== 'function') {
    throw new OpenAIOAuthError('fetch must be a fetch-compatible function.');
  }
}

function isSupportedHostId(hostId: string): boolean {
  return /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(hostId)
    || /^urn:ietf:params:oauth:jwk-thumbprint:\S+$/.test(hostId);
}

function modelCapabilities(id: string): OpenAIModelCatalogEntry['capabilities'] {
  return {
    route: {
      text: true, mandatoryStreaming: true, nonStreamingHttp: false, filesUpload: false, audioVideo: false,
      imageGeneration: false, fileSearch: false, codeInterpreter: false, computerUse: false, hostedMcp: false,
      toolSearch: false, persistentResponses: false,
    },
    // The route supports these forms, but a list-visible model is not itself an
    // account-backed entitlement result. Keep model-specific evidence honest.
    text: 'advertised', streaming: 'advertised', nonStreamingHttp: 'advertised',
    filesUpload: 'advertised', audioVideo: 'advertised', imageGeneration: 'advertised', fileSearch: 'advertised',
    codeInterpreter: 'advertised', computerUse: 'advertised', hostedMcp: 'advertised', toolSearch: 'advertised',
    persistentResponses: 'advertised', reasoning: id === 'gpt-5.6-terra' ? 'validated' : 'unknown',
    tools: id === 'gpt-5.6-terra' ? 'validated' : 'unknown', images: id === 'gpt-5.6-terra' ? 'validated' : 'unknown', files: id === 'gpt-5.6-terra' ? 'validated' : 'unknown', webSearch: 'unknown', jsonSchema: id === 'gpt-5.6-terra' ? 'validated' : 'unknown', detailedUsage: id === 'gpt-5.6-terra' ? 'validated' : 'unknown',
  };
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }

interface TokenResponse { access_token: string; refresh_token: string; id_token?: string; expires_in: number; scope?: string; earliest_refresh_at?: number }
function randomValue() { return base64url(randomBytes(32)); }
function base64url(value: Uint8Array) { return Buffer.from(value).toString('base64url'); }

interface CallbackResult {
  params: URLSearchParams;
  respond: (status: 'success' | 'error') => void;
}

export function createCallbackServer() {
  let resolve: ((value: CallbackResult) => void) | undefined;
  let reject: ((reason: Error) => void) | undefined;
  const result = new Promise<CallbackResult>((res, rej) => { resolve = res; reject = rej; });
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/auth/callback') { response.writeHead(404).end(); return; }
    resolve?.({
      params: url.searchParams,
      respond(status) {
        if (response.writableEnded) return;
        const callbackResponse = callbackPageResponse(status);
        response.writeHead(callbackResponse.status, callbackResponse.headers).end(callbackResponse.body);
      },
    });
  });
  return {
    get redirectUri() { const address = server.address(); if (!address || typeof address === 'string') throw new Error('OAuth callback server did not start.'); return `http://127.0.0.1:${address.port}/auth/callback`; },
    async start() { await new Promise<void>((res, rej) => server.listen(0, '127.0.0.1', res).once('error', rej)); },
    async waitForCallback() { return result; },
    close() { server.close(); reject?.(new Error('OAuth callback server closed.')); },
  };
}

function callbackPageResponse(status: 'success' | 'error') {
  return {
    status: status === 'success' ? 200 : 400,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    },
    body: callbackPage(status),
  };
}


function callbackPage(status: 'success' | 'error'): string {
  const success = status === 'success';
  const title = success ? 'Sign-in complete' : 'Sign-in could not be completed';
  const message = success
    ? 'Your account has been connected. You can safely close this window and return to the app.'
    : 'Your account was not connected. Return to the app and try again.';
  const icon = success ? '&#10003;' : '!';

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>${title}</title><style>:root{color-scheme:light dark;--bg:#fff;--text:#0d0d0d;--muted:#6b6b6b;--status-bg:#f4f4f4;--success:#0d0d0d;--error:#d00e17}@media(prefers-color-scheme:dark){:root{--bg:#212121;--text:#ececec;--muted:#b4b4b4;--status-bg:#2f2f2f;--success:#fff;--error:#ff6b6b}}*{box-sizing:border-box}html,body{margin:0;min-height:100%}body{min-height:100vh;display:grid;place-items:center;padding:24px;background:var(--bg);color:var(--text);font:16px/1.5 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}main{width:min(100%,420px);text-align:center}.icon{width:48px;height:48px;margin:0 auto 24px;display:grid;place-items:center;border-radius:50%;background:var(--status-bg);color:${success ? 'var(--success)' : 'var(--error)'};font-size:24px;font-weight:600;line-height:1}h1{margin:0 0 10px;font-size:24px;line-height:1.25;font-weight:600;letter-spacing:-.02em}p{margin:0 auto;max-width:380px;color:var(--muted);font-size:15px;line-height:1.55}.hint{margin-top:24px;color:var(--muted);font-size:13px}</style></head><body><main><div class="icon" aria-hidden="true">${icon}</div><h1>${title}</h1><p>${message}</p><div class="hint">You can close this window.</div></main><script>window.addEventListener('load',()=>{if(window.location.search)history.replaceState(null,'',window.location.pathname+window.location.hash)});</script></body></html>`;
}

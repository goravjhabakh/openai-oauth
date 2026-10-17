export interface OAuthCredentials {
  clientId: string;
  hostId: string;
  identity: { issuer: string; sub: string; email?: string };
  accessToken: string;
  refreshToken: string;
  idToken: string;
  expiresAt: number;
  scopes: string[];
  earliestRefreshAt?: number;
}

export interface CredentialStore {
  load(key: string): Promise<OAuthCredentials | null>;
  save(key: string, credentials: OAuthCredentials): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface OpenAIModel {
  id: string;
  name: string;
}

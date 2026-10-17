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

export type CapabilityState = 'advertised' | 'validated' | 'unknown';

/** Route-wide availability, independent of account/model entitlement. */
export interface OpenAIOAuthRouteCapabilities {
  text: true;
  mandatoryStreaming: true;
  nonStreamingHttp: false;
  filesUpload: false;
  audioVideo: false;
  imageGeneration: false;
  fileSearch: false;
  codeInterpreter: false;
  computerUse: false;
  hostedMcp: false;
  toolSearch: false;
  persistentResponses: false;
}

export interface OpenAIModelCapabilities {
  route: OpenAIOAuthRouteCapabilities;
  text: CapabilityState;
  streaming: CapabilityState;
  nonStreamingHttp: CapabilityState;
  filesUpload: CapabilityState;
  audioVideo: CapabilityState;
  imageGeneration: CapabilityState;
  fileSearch: CapabilityState;
  codeInterpreter: CapabilityState;
  computerUse: CapabilityState;
  hostedMcp: CapabilityState;
  toolSearch: CapabilityState;
  persistentResponses: CapabilityState;
  reasoning: CapabilityState;
  tools: CapabilityState;
  images: CapabilityState;
  files: CapabilityState;
  webSearch: CapabilityState;
  jsonSchema: CapabilityState;
  detailedUsage: CapabilityState;
}

/** Account-specific catalog information. Listing a model is not an entitlement guarantee. */
export interface OpenAIModelCatalogEntry extends OpenAIModel {
  capabilities: OpenAIModelCapabilities;
  advertisedCapabilities?: Record<string, unknown>;
}

import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { generateText } from 'ai';
import { createOpenAIOAuth, FileCredentialStore } from '../dist/index.js';

const execFileAsync = promisify(execFile);
const root = resolve('validation');
const hostPath = resolve(root, 'host-id.txt');
const credentialPath = resolve(root, 'credentials.json');
const resultPath = resolve(root, 'result.json');

await mkdir(root, { recursive: true });
let hostId;
try { hostId = (await readFile(hostPath, 'utf8')).trim(); }
catch {
  hostId = `urn:uuid:${crypto.randomUUID()}`;
  await writeFile(hostPath, `${hostId}\n`, { mode: 0o600 });
}

const store = new FileCredentialStore(credentialPath);
const provider = createOpenAIOAuth({
  agentName: process.env.OPENAI_OAUTH_AGENT_NAME ?? 'openai-oauth v0.1 local validation',
  hostId,
  credentialStore: store,
  credentialKey: 'live-validation',
  openAuthorizationUrl: async url => {
    await execFileAsync('rundll32.exe', ['url.dll,FileProtocolHandler', url]);
  },
});

console.log('Opening the OpenAI authorization page in your default browser.');
await provider.auth.signIn();

const credentials = await store.load('live-validation');
const models = await provider.auth.listModels();
if (models.length === 0) throw new Error('No list-visible models were returned for this account.');
const modelId = process.env.OPENAI_OAUTH_MODEL ?? models[0].id;
const result = await generateText({ model: provider(modelId), prompt: 'Reply with exactly: oauth-v0.1-ok' });

const beforeRefresh = await store.load('live-validation');
if (!beforeRefresh) throw new Error('Credentials disappeared before refresh validation.');
await store.save('live-validation', { ...beforeRefresh, expiresAt: 0 });
await provider.auth.listModels();
const afterRefresh = await store.load('live-validation');
if (!afterRefresh) throw new Error('Credentials disappeared during refresh validation.');

const summary = {
  validatedAt: new Date().toISOString(),
  oauth: {
    issuedClientIdPrefix: credentials?.clientId.slice(0, 7),
    scopeNames: credentials?.scopes,
    hasEarliestRefreshAt: credentials?.earliestRefreshAt !== undefined,
    identityValidated: Boolean(credentials?.identity.sub && credentials.identity.issuer),
  },
  models: { count: models.length, selectedModel: modelId },
  generation: {
    textMatched: result.text === 'oauth-v0.1-ok',
    finishReason: result.finishReason,
    usagePresent: result.usage.totalTokens !== undefined,
    responseIdPresent: Boolean(result.response.id),
  },
  refresh: {
    accessTokenRotated: afterRefresh.accessToken !== beforeRefresh.accessToken,
    refreshTokenRotated: afterRefresh.refreshToken !== beforeRefresh.refreshToken,
    credentialsRemainUsable: afterRefresh.expiresAt > Date.now(),
  },
};
if (process.env.OPENAI_OAUTH_VALIDATE_SIGN_OUT === '1') {
  await provider.auth.signOut();
  summary.signOut = { credentialDeleted: await store.load('live-validation') === null };
}
await writeFile(resultPath, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify(summary, null, 2));

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { FileCredentialStore, createOpenAIOAuth } from '../dist/index.js';

const root = resolve('validation');
const provider = createOpenAIOAuth({
  agentName: process.env.OPENAI_OAUTH_AGENT_NAME ?? 'openai-oauth v0.5 local validation',
  hostId: (await readFile(resolve(root, 'host-id.txt'), 'utf8')).trim(),
  credentialStore: new FileCredentialStore(resolve(root, 'credentials.json')),
  credentialKey: 'live-validation', openAuthorizationUrl() {},
});
const models = await provider.auth.listModels();
const modelId = process.env.OPENAI_OAUTH_MODEL ?? models.find(({ id }) => id === 'gpt-5.6-terra')?.id;
if (!modelId) throw new Error('gpt-5.6-terra was not list-visible; set OPENAI_OAUTH_MODEL only after validating that model.');
const model = provider(modelId);
const prompt = content => [{ role: 'user', content }];
const url = new URL('https://raw.githubusercontent.com/github/explore/main/topics/javascript/javascript.png');
const textUrl = new URL('https://raw.githubusercontent.com/github/gitignore/main/Node.gitignore');
const imageResponse = await fetch(url);
if (!imageResponse.ok) throw new Error(`Could not obtain the public validation image (${imageResponse.status}).`);
const png = Buffer.from(await imageResponse.arrayBuffer()).toString('base64');
const checks = {
  jsonSchema: { prompt: prompt([{ type: 'text', text: 'Return the requested object.' }]), responseFormat: { type: 'json', name: 'answer', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } } },
  imageInline: { prompt: prompt([{ type: 'text', text: 'Reply with one word: image.' }, { type: 'file', mediaType: 'image/png', data: { type: 'data', data: png } }]) },
  imageUrl: { prompt: prompt([{ type: 'text', text: 'Reply with one word: image.' }, { type: 'file', mediaType: 'image/png', data: { type: 'url', url } }]) },
  fileInline: { prompt: prompt([{ type: 'text', text: 'Reply with the file content.' }, { type: 'file', mediaType: 'text/plain', filename: 'note.txt', data: { type: 'text', text: 'v0.5 inline file' } }]) },
  fileUrl: { prompt: prompt([{ type: 'text', text: 'Reply with one word: file.' }, { type: 'file', mediaType: 'text/plain', data: { type: 'url', url: textUrl } }]) },
};
const summary = {};
for (const [name, options] of Object.entries(checks)) {
  const generated = await model.doGenerate(options);
  const streamed = await model.doStream(options);
  const parts = [];
  for await (const part of streamed.stream) parts.push(part);
  summary[name] = { generateCompleted: generated.finishReason.unified === 'stop', streamCompleted: parts.at(-1)?.type === 'finish' && parts.at(-1).finishReason.unified === 'stop' };
}
let rejectedSchema = false;
try {
  await model.doGenerate({ prompt: prompt([{ type: 'text', text: 'This request must be rejected.' }]), responseFormat: { type: 'json', name: 'bad', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } } });
} catch (error) {
  rejectedSchema = error?.options?.status === 400;
}
if (!rejectedSchema) throw new Error('The deliberately invalid strict JSON Schema was not rejected with HTTP 400.');
await writeFile(resolve(root, 'v0.5-result.json'), `${JSON.stringify({ validatedAt: new Date().toISOString(), modelId, ...summary }, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ modelId, ...summary }, null, 2));

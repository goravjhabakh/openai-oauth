import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { FileCredentialStore, createOpenAIOAuth } from '../dist/index.js';

const root = resolve('validation');
const store = new FileCredentialStore(resolve(root, 'credentials.json'));
const hostId = (await readFile(resolve(root, 'host-id.txt'), 'utf8')).trim();
const provider = createOpenAIOAuth({
  agentName: process.env.OPENAI_OAUTH_AGENT_NAME ?? 'openai-oauth v0.4 local validation',
  hostId,
  credentialStore: store,
  credentialKey: 'live-validation',
  openAuthorizationUrl() {},
});
const models = await provider.auth.listModels();
const modelId = process.env.OPENAI_OAUTH_MODEL ?? models.find(model => model.id === 'gpt-5.6-terra')?.id ?? models[0]?.id;
if (!modelId) throw new Error('No list-visible models were returned for this account.');

const tool = {
  type: 'function',
  name: 'get_weather',
  description: 'Gets the weather for a city.',
  inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false },
};
const prompt = [{ role: 'user', content: [{ type: 'text', text: 'Use get_weather for Paris. Do not answer with prose.' }] }];
const stream = await provider(modelId).doStream({ prompt, tools: [tool], toolChoice: { type: 'required' } });
const parts = [];
for await (const part of stream.stream) parts.push(part);
const call = parts.find(part => part.type === 'tool-call');
if (!call) throw new Error('The model did not return a function call.');
const result = await provider(modelId).doGenerate({
  prompt: [...prompt,
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: call.toolCallId, toolName: call.toolName, input: JSON.parse(call.input) }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: call.toolCallId, toolName: call.toolName, output: { type: 'text', value: 'Sunny, 20 C.' } }] },
  ],
  tools: [tool],
  toolChoice: { type: 'none' },
});

const summary = {
  validatedAt: new Date().toISOString(),
  modelId,
  stream: {
    inputStarted: parts.some(part => part.type === 'tool-input-start' && part.id === call.toolCallId),
    inputDeltaCount: parts.filter(part => part.type === 'tool-input-delta' && part.id === call.toolCallId).length,
    inputEnded: parts.some(part => part.type === 'tool-input-end' && part.id === call.toolCallId),
    finishReason: parts.at(-1)?.type === 'finish' ? parts.at(-1).finishReason.unified : undefined,
  },
  resultTurn: { completed: result.finishReason.unified === 'stop', textReturned: result.content.some(part => part.type === 'text') },
};
await writeFile(resolve(root, 'v0.4-result.json'), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify(summary, null, 2));

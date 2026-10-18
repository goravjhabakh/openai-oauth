import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { generateText, isStepCount, jsonSchema, Output, streamText, tool } from 'ai';
import { createOpenAIOAuth, FileCredentialStore } from '@gorav/openai-oauth';

const execFileAsync = promisify(execFile);
const privateDirectory = join(process.cwd(), '.private-live');
const credentialsPath = join(privateDirectory, 'credentials.json');
const hostPath = join(privateDirectory, 'host-id.txt');
const credentialKey = 'packed-live-validation';

async function openAuthorizationUrl(url: string): Promise<void> {
  if (process.platform === 'win32') {
    await execFileAsync('rundll32.exe', ['url.dll,FileProtocolHandler', url]);
  } else if (process.platform === 'darwin') {
    await execFileAsync('open', [url]);
  } else {
    await execFileAsync('xdg-open', [url]);
  }
}

async function requireStopped(result: Promise<{ text: string }>, name: string): Promise<void> {
  if (!(await result).text.trim()) throw new Error(`${name} returned no text.`);
}

await mkdir(privateDirectory, { recursive: true, mode: 0o700 });
let hostId: string;
try {
  hostId = (await readFile(hostPath, 'utf8')).trim();
} catch {
  hostId = `urn:uuid:${crypto.randomUUID()}`;
  await writeFile(hostPath, `${hostId}\n`, { mode: 0o600 });
}

const provider = createOpenAIOAuth({
  agentName: process.env.OPENAI_OAUTH_AGENT_NAME ?? 'OpenAI OAuth packed consumer validation',
  hostId,
  credentialStore: new FileCredentialStore(credentialsPath),
  credentialKey,
  openAuthorizationUrl,
});

try {
  console.log('Opening the OpenAI authorization page in your default browser.');
  await provider.auth.signIn();
  const models = await provider.auth.listModels();
  const modelId = process.env.OPENAI_OAUTH_MODEL ?? models.find(model => model.id === 'gpt-5.6-terra')?.id;
  if (!modelId) throw new Error('gpt-5.6-terra was not list-visible; do not substitute a different model for this validation.');
  const model = provider(modelId);

  console.log('Validating generateText().');
  await requireStopped(generateText({ model, prompt: 'Reply with exactly: packed-generate-ok' }), 'generateText()');

  console.log('Validating streamText().');
  const streaming = streamText({ model, prompt: 'Reply with exactly: packed-stream-ok' });
  let streamedText = '';
  for await (const delta of streaming.textStream) streamedText += delta;
  if (!streamedText.trim()) throw new Error('streamText() returned no text.');

  console.log('Validating reasoning.');
  await requireStopped(generateText({
    model,
    prompt: 'Reply with exactly: packed-reasoning-ok',
    providerOptions: { 'openai-oauth': { effort: 'medium' } },
  }), 'reasoning');

  console.log('Validating tool call and result continuation.');
  const toolResult = await generateText({
    model,
    prompt: 'Use get_weather for Paris, then reply with its result.',
    tools: {
      get_weather: tool({
        description: 'Gets the weather for a city.',
        inputSchema: jsonSchema({ type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false }),
        execute: async () => 'Sunny, 20 C.',
      }),
    },
    toolChoice: 'required',
    stopWhen: isStepCount(2),
    prepareStep: ({ stepNumber }) => stepNumber === 1 ? { toolChoice: 'none' } : {},
  });
  if (toolResult.toolCalls.length === 0 || toolResult.toolResults.length === 0 || !toolResult.text.trim()) {
    throw new Error('Tool call and result continuation did not complete.');
  }

  console.log('Validating structured output.');
  const schema = { type: 'object' as const, properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
  const structured = await generateText({
    model,
    prompt: 'Return an object with ok set to true.',
    output: Output.object({ schema: jsonSchema(schema) }),
  });
  if (!structured.output || typeof structured.output !== 'object') throw new Error('Structured output did not produce an object.');

  const imageUrl = new URL('https://raw.githubusercontent.com/github/explore/main/topics/javascript/javascript.png');
  const textUrl = new URL('https://raw.githubusercontent.com/github/gitignore/main/Node.gitignore');
  const imageResponse = await fetch(imageUrl);
  if (!imageResponse.ok) throw new Error(`Could not obtain the public validation image (${imageResponse.status}).`);
  const png = Buffer.from(await imageResponse.arrayBuffer()).toString('base64');
  const richInputs = [
    { name: 'inline PNG', content: [{ type: 'text' as const, text: 'Reply with one word: image.' }, { type: 'file' as const, mediaType: 'image/png', data: png }] },
    { name: 'PNG URL', content: [{ type: 'text' as const, text: 'Reply with one word: image.' }, { type: 'file' as const, mediaType: 'image/png', data: imageUrl }] },
    { name: 'inline text file', content: [{ type: 'text' as const, text: 'Reply with one word: file.' }, { type: 'file' as const, mediaType: 'text/plain', filename: 'note.txt', data: { type: 'text' as const, text: 'packed inline file' } }] },
    { name: 'text file URL', content: [{ type: 'text' as const, text: 'Reply with one word: file.' }, { type: 'file' as const, mediaType: 'text/plain', data: textUrl }] },
  ];
  for (const input of richInputs) {
    console.log(`Validating ${input.name}.`);
    await requireStopped(generateText({ model, prompt: [{ role: 'user', content: input.content }] }), input.name);
  }

  console.log(JSON.stringify({ modelId, modelsListed: models.length, validations: ['sign-in', 'models', 'generateText', 'streamText', 'reasoning', 'tools', 'structured-output', 'image-inputs', 'file-inputs'] }, null, 2));
} finally {
  try {
    await provider.auth.signOut();
  } finally {
    await rm(privateDirectory, { recursive: true, force: true });
  }
}

# @gorav/openai-oauth

A local Node.js Vercel AI SDK provider that authenticates with an OpenAI/ChatGPT account rather than a separately billed API key. This is a preview implementation of OpenAI's Sign in with ChatGPT plan-sharing flow; it is for local/open-source use, not a blanket authorization for hosted or commercial apps.

## v0.1

```ts
import { generateText } from 'ai';
import { createOpenAIOAuth, FileCredentialStore } from '@gorav/openai-oauth';

const openaiOAuth = createOpenAIOAuth({
  agentName: 'My local app',
  hostId: 'urn:uuid:replace-with-a-persisted-uuid',
  credentialStore: new FileCredentialStore('/private/path/openai-oauth.json'),
  credentialKey: 'default',
  openAuthorizationUrl: url => { /* open url in the user's browser */ },
});

await openaiOAuth.auth.signIn();
const models = await openaiOAuth.auth.listModels();
const { text } = await generateText({ model: openaiOAuth(models[0].id), prompt: 'Hello' });
```

`generateText()` is supported. `streamText()`, tools, structured output, richer inputs, and hosted/browser use are not part of v0.1.

## Docs

- `docs/project.md` — what the project is and why it exists
- `docs/roadmap.md` — planned versions and direction
- `docs/research.md` — confirmed findings, experiments, and open questions
- `AGENTS.md` — instructions for AI coding agents working in this repository

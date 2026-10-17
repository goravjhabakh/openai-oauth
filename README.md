# @gorav/openai-oauth

A Node.js Vercel AI SDK provider that authenticates with an OpenAI/ChatGPT
account instead of a separately billed OpenAI API key.

It uses OpenAI's public **Sign in with ChatGPT** OAuth plan-sharing flow and
the public Responses API. It does not use Codex CLI or private ChatGPT routes.

> **Pre-release:** This package is under active development toward v1.0 and is
> not yet published to npm. It is intended for local development from this
> repository. OpenAI's plan-sharing flow is a preview and is for local/open-
> source use; it is not blanket authorization for hosted or commercial apps.

## What works today

- OAuth sign-in, token refresh, and sign-out
- Account-aware model discovery
- `generateText()` and text-only `streamText()`
- Required Responses SSE streaming, including client-side aggregation for
  `generateText()`
- Safe response metadata, terminal usage, cancellation, and actionable errors
- One account-backed validated reasoning setting: `gpt-5.6-terra` with medium
  effort

Tools, structured output, rich inputs, browser support, and most reasoning
controls are not supported yet. See [Roadmap](#roadmap).

## Requirements

- Node.js 20 or later
- pnpm
- A consenting OpenAI/ChatGPT account eligible for the plan-sharing flow
- A local browser opener for the OAuth consent URL

The application must persist a stable opaque host ID and protect its credential
file. Do not commit credentials, host IDs, tokens, or authorization URLs.

## Local setup

Until the v1.0 npm release, clone this repository and install its dependencies:

```bash
pnpm install
pnpm build
```

The package declares `ai` as a peer dependency. Consumers in a workspace should
install a compatible AI SDK version in their application.

## Quick start

```ts
import { generateText } from 'ai';
import { createOpenAIOAuth, FileCredentialStore } from '@gorav/openai-oauth';

const openaiOAuth = createOpenAIOAuth({
  agentName: 'My local app',
  // Generate once and persist this value for this installation.
  hostId: 'urn:uuid:replace-with-a-persisted-uuid',
  credentialStore: new FileCredentialStore('/private/path/openai-oauth.json'),
  credentialKey: 'default',
  // Open this URL with the platform browser launcher in your application.
  openAuthorizationUrl: async url => { /* open url in the user's browser */ },
});

await openaiOAuth.auth.signIn();

const models = await openaiOAuth.auth.listModelCatalog();
const { text } = await generateText({
  model: openaiOAuth(models[0].id),
  prompt: 'Hello',
});
```

`signIn()` starts a temporary `127.0.0.1` callback listener and waits for the
user to complete browser consent. Call it before model discovery or generation.

## Streaming

```ts
import { streamText } from 'ai';

const result = streamText({
  model: openaiOAuth(models[0].id),
  prompt: 'Write a short greeting.',
});

for await (const delta of result.textStream) process.stdout.write(delta);
```

The OAuth route requires `stream: true` and `store: false`. The provider always
sends those settings; `generateText()` aggregates the server-sent event stream
before returning its result.

## Models and capabilities

Use `listModelCatalog()` when selecting a model:

```ts
const catalog = await openaiOAuth.auth.listModelCatalog();
```

It retains the account's server order and only list-visible models. Each entry
has route-wide availability plus model capability evidence:

- `validated`: confirmed with an account-backed request
- `advertised`: documented route-wide behavior, not a model entitlement
- `unknown`: not yet verified for that model/account

Being listed is not a guarantee that a request is entitled to run.

## Reasoning

The only supported provider option is the following exact model/control pair:

```ts
await generateText({
  model: openaiOAuth('gpt-5.6-terra'),
  prompt: 'Solve this carefully.',
  providerOptions: { 'openai-oauth': { effort: 'medium' } },
});
```

It is not a provider default and does not imply support for another model,
effort value, reasoning summaries, or visible reasoning text.

## API overview

- `openaiOAuth.auth.signIn()` — browser OAuth sign-in and credential storage
- `openaiOAuth.auth.signOut()` — revoke the saved refresh token and delete local
  credentials
- `openaiOAuth.auth.listModels()` — simple `{ id, name }` list
- `openaiOAuth.auth.listModelCatalog()` — capability-aware catalog
- `openaiOAuth(modelId)` — create an AI SDK language model

Responses include standard AI SDK metadata where available. OAuth-specific safe
protocol facts, such as terminal status and raw usage, are exposed under
`providerMetadata['openai-oauth']`. Tokens, identity claims, authorization URLs,
and request bodies are never included in provider metadata.

## Limitations

- Public `/v1/responses` only; no private ChatGPT/Codex endpoints
- Full conversation history is sent for each request; persistent Responses
  state is unavailable
- Unsupported generic settings produce AI SDK warnings instead of being sent
- No retries, billing fallback, or automatic OAuth reauthorization
- Account-backed streaming validation remains incomplete for terminal failures,
  interrupted streams, and cancellation

## Roadmap

- v0.3: provider features — current implementation
- v0.4: tools, if the documented OAuth route supports them cleanly
- v0.5: richer inputs and structured output, after validation
- v1.0: stable, publishable language-model provider

## Development

```bash
pnpm typecheck
pnpm test
pnpm build
```

## Documentation

- [`docs/project.md`](docs/project.md) — project goal and principles
- [`docs/roadmap.md`](docs/roadmap.md) — version direction and status
- [`docs/architecture.md`](docs/architecture.md) — component boundaries
- [`docs/research.md`](docs/research.md) — verified protocol findings and open questions
- [`docs/versions/`](docs/versions/) — version-specific specifications
- [`AGENTS.md`](AGENTS.md) — contributor guidance for coding agents

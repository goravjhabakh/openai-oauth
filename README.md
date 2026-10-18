# @goravjhabakh/openai-oauth

A Node.js Vercel AI SDK provider that authenticates with an OpenAI/ChatGPT
account instead of a separately billed OpenAI API key.

It uses OpenAI's public **Sign in with ChatGPT** OAuth plan-sharing flow and
the public Responses API. It does not use Codex CLI or private ChatGPT routes.

> **OAuth preview boundary:** This package has a stable 1.0 public API, but
> OpenAI's plan-sharing service remains a preview for local/open-source use.
> It is not blanket authorization for hosted or commercial apps. Use the
> published package only where OpenAI's current terms and approval process
> permit it; this provider never silently changes billing sources.

## What works today

- OAuth sign-in, token refresh, and sign-out
- Account-aware model discovery
- `generateText()` and `streamText()`
- Required Responses SSE streaming, including client-side aggregation for
  `generateText()`
- Safe response metadata, terminal usage, cancellation, and actionable errors
- One account-backed validated reasoning setting: `gpt-5.6-terra` with medium
  effort

- Client-executed function tools (the validated top-level function form)
- Strict JSON-schema output through AI SDK 7 `Output.object()`
- User PNG and `text/plain` URL/inline file inputs on `gpt-5.6-terra`

Browser support and every unlisted reasoning/tool/media form remain unsupported.

## Requirements

- Node.js 20 or later
- pnpm
- A consenting OpenAI/ChatGPT account eligible for the plan-sharing flow
- A local browser opener for the OAuth consent URL

The application must persist a stable opaque host ID and protect its credential
file. Do not commit credentials, host IDs, tokens, or authorization URLs. Use a
recommended JWK-thumbprint URN where available, or a UUIDv4 with its required
`urn:uuid:` prefix. A bare UUID is not a valid host ID.

## Installation

Install the provider and its AI SDK 7 peer dependency:

```bash
pnpm add @goravjhabakh/openai-oauth ai
```

The package is ESM-only and requires Node.js 20 or later. Use only the root
import, `@goravjhabakh/openai-oauth`; subpath and `dist` imports are unsupported.

## Quick start

```ts
import { generateText } from 'ai';
import { createOpenAIOAuth, FileCredentialStore } from '@goravjhabakh/openai-oauth';

const openaiOAuth = createOpenAIOAuth({
  agentName: 'My local app',
  // Generate a UUIDv4 once, add the urn:uuid: prefix, and persist it for this installation.
  hostId: 'urn:uuid:6ba7b810-9dad-41d1-80b4-00c04fd430c8',
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

`agentName` is the consuming application's real user-facing name, not this
library's name. `signIn()` starts a temporary `127.0.0.1` callback listener and
waits for browser consent. Call it before model discovery or generation. If a
browser is unavailable, fix that local environment and call it again; the
provider never silently reauthorizes or changes billing sources. After loading,
the callback page clears OAuth query parameters from its browser URL.

### Host IDs

The consuming application, not this package, owns and persists its stable host
ID. OpenAI recommends a JWK-thumbprint URN in the form
`urn:ietf:params:oauth:jwk-thumbprint:<value>`. A UUID alternative must be a
UUIDv4 prefixed with `urn:uuid:`, for example
`urn:uuid:6ba7b810-9dad-41d1-80b4-00c04fd430c8`. Do not pass a bare UUID: it is
rejected locally before the browser is opened.

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

## Tools

Client-executed AI SDK function tools use the validated top-level Responses
function form. `auto`, `none`, `required`, and a named supplied function are
supported. Tool results must be text or JSON, and the next request must include
the complete conversation/tool history. Provider-hosted tools and other tool
encodings are not supported.

```ts
import { generateText, tool } from 'ai';

const result = await generateText({
  model: openaiOAuth(models[0].id),
  prompt: 'What is the weather in Paris?',
  tools: { weather: tool({ description: 'Get weather.', inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }) },
  toolChoice: 'required',
});
```

Execute `result.toolCalls` in the application, then submit their results with
the full AI SDK message history on the next call.

## Structured output and rich input

On `gpt-5.6-terra` only, use AI SDK 7 `Output.object()` with `generateText()`
or `streamText()`. It maps to strict Responses JSON Schema; schemas must satisfy
the upstream strict-schema requirements (for example, `additionalProperties:
false` where required). This does not validate another model or a deprecated
structured-output API.

```ts
import { generateText, jsonSchema, Output } from 'ai';

await generateText({
  model: openaiOAuth('gpt-5.6-terra'),
  prompt: 'Return whether this is valid.',
  output: Output.object({ schema: jsonSchema({ type: 'object', properties: { valid: { type: 'boolean' } }, required: ['valid'], additionalProperties: false }) }),
});
```

The same model accepts user `image/png` and `text/plain` file parts as HTTP(S)
URLs or inline data. For an inline plain-text file, use AI SDK's tagged form
`data: { type: 'text', text: '...' }`; a bare string is base64 file data.
Other media types, provider file references, file uploads, and unsupported
history forms fail locally.

## Errors and recovery

`OpenAIOAuthError` exposes redacted `message`, `status`, `code`, `param`,
`requestId`, and `retry` (`none`, `backoff`, or `reauthorize`) fields directly.
Correct local/request input errors; use bounded backoff for `retry: 'backoff'`;
and offer deliberate sign-in again for `retry: 'reauthorize'`. Eligibility and
usage-limit errors should direct users to ChatGPT settings rather than trigger
automatic retries. Errors never intentionally include tokens, identity claims,
authorization URLs, request bodies, or tool input.

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
- Account-backed validation remains incomplete for terminal failures,
  interrupted streams, and cancellation
- Refresh is deduplicated within one `OpenAIOAuth` instance only. Do not share
  one credential record between processes: a concurrent refresh can race the
  rotating refresh token. Use one credential record per process or provide a
  credential store with cross-process refresh coordination.
- Live account coverage does not yet include cancellation, interrupted
  transport, terminal failure/incomplete events, or admission-error mappings.
  Cross-process refresh coordination, crash recovery, corrupt-record handling,
  and file-store durability still need coverage on Windows, macOS, and Linux.
- Model catalog and entitlement differences have been observed for one
  consenting account only. A listed model is never an entitlement guarantee.

## Roadmap

- v1.0: stable, release-ready language-model provider

## Development

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm validate:package
# all offline release checks:
pnpm release-check
```

`validate:package` inspects the packed tarball, installs it in an independent
temporary pnpm consumer, then type-checks and runs offline mock usage through
the public root exports. `pnpm validate:consumer:live` runs the same packed
consumer fixture against a consenting account, performs a browser sign-in, and
signs out before deleting its temporary credentials. Live validation must not
log credentials, URLs, request bodies, outputs, or request IDs.

Publishing, tagging, and GitHub Release creation are deliberate manual release
steps and are not performed by these commands.

Maintainers should follow the trusted-publishing setup and release procedure in
[`docs/release.md`](docs/release.md). Publishing is performed only by the
protected GitHub Actions workflow, not from a workstation.

## Documentation

- [`docs/project.md`](docs/project.md) — project goal and principles
- [`docs/roadmap.md`](docs/roadmap.md) — version direction and status
- [`docs/architecture.md`](docs/architecture.md) — component boundaries
- [`docs/research.md`](docs/research.md) — verified protocol findings and open questions
- [`docs/versions/`](docs/versions/) — version-specific specifications
- [`AGENTS.md`](AGENTS.md) — contributor guidance for coding agents

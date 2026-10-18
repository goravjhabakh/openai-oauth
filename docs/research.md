# Research

Research snapshot: 2026-10-17.

This file separates documented behavior from implementation assumptions. OpenAI's
Sign in with ChatGPT feature is a preview, so endpoints and constraints must be
rechecked before implementation and release.

## Executive conclusion

The project is technically feasible without spawning Codex CLI.

OpenAI now documents an open-source, locally hosted OAuth flow that lets an app
use a consenting user's ChatGPT plan for eligible requests. The supported route
is:

1. dynamically register a user-defined OAuth client in the browser;
2. exchange and refresh tokens as a public PKCE client;
3. call `https://api.openai.com/v1/models` and
   `https://api.openai.com/v1/responses` directly with the OAuth access token.

This is distinct from Codex CLI's own first-party OAuth client and its private
`https://chatgpt.com/backend-api/codex` route. OpenAI explicitly says OSS clients
using ChatGPT plan sharing should use the public Responses API and not ChatGPT
`backend-api` endpoints.

The main protocol constraint is that every inference request must use
`store: false` and `stream: true`. A future AI SDK `doGenerate()` implementation
will therefore need to consume and aggregate a Responses SSE stream internally;
the normal non-streaming OpenAI Responses call is not available on this route.

## Confirmed findings

### 1. Supported OAuth flow for open-source clients

The supported OSS flow is OAuth 2.0 Authorization Code with PKCE plus OpenID
Connect. It is a public-client flow: it requires neither a client secret nor a
partner API key.

For first-time registration:

- Generate and persist a stable, opaque host identifier before login.
  OpenAI recommends an RFC 9278 JWK thumbprint URI; `urn:uuid:<UUIDv4>` and
  `did:key:<key>` are also accepted.
- Start an HTTP callback listener on `127.0.0.1`. The documented callback path is
  `/auth/callback`; the port may vary between attempts. Do not substitute
  `localhost`.
- Generate fresh `state`, OIDC `nonce`, and PKCE S256 values for every attempt.
- Open `https://auth.openai.com/api/accounts/authorize` with:
  - `client_id=dynamic_agent_client`
  - the app's real, consistently used `agent_name_hint`
  - `ext_agent_host_id`
  - `response_type=code`
  - the exact loopback `redirect_uri`
  - `scope=openid profile email offline_access resource.invoke chatgpt.tokens.use.direct`
  - `resource=https://api.openai.com/v1`
  - `state`, `nonce`, `code_challenge_method=S256`, and `code_challenge`
- A successful first callback returns an issued client ID, typically shaped like
  `oaiapp_...`, in addition to `code` and `state`.
- Exchange the code at
  `https://auth.openai.com/api/accounts/oauth/token` using the issued client ID,
  the PKCE verifier, the same redirect URI, and the same resource.

`dynamic_agent_client` is only the registration entrypoint. It must never be
saved as the issued client ID or used for token exchange/refresh.

For later authorization, reuse the issued client ID and the host's stable host
ID. A retained ID token may be sent as `id_token_hint`; a validated email may be
sent as `login_hint`. Both are account-selection hints, not substitutes for
validating the newly returned ID token.

The ID token must be validated using OpenAI's JWKS. Validate at least signature,
issuer, audience (the issued client ID), expiry, and the nonce from the pending
attempt. Use validated `sub`, rather than email, as the account identity. Also
verify that the token response granted `chatgpt.tokens.use.direct`; identity
alone does not authorize inference against the ChatGPT plan.

OpenAI's discovery document currently confirms:

- issuer: `https://auth.openai.com`
- authorization endpoint: `https://auth.openai.com/api/accounts/authorize`
- token endpoint: `https://auth.openai.com/api/accounts/oauth/token`
- revocation endpoint: `https://auth.openai.com/api/accounts/oauth/revoke`
- JWKS: `https://auth.openai.com/.well-known/jwks.json`
- authorization-code and refresh-token grants, PKCE S256, RS256 ID tokens, and
  public clients (`token_endpoint_auth_methods_supported` includes `none`)

#### How this differs from Codex CLI login

Current Codex source uses a first-party static client ID, a loopback PKCE flow at
`/oauth/authorize` and `/oauth/token`, and scopes including
`api.connectors.read` and `api.connectors.invoke`. It stores ChatGPT account data
from its tokens and normally routes ChatGPT-authenticated inference to
`https://chatgpt.com/backend-api/codex`.

Codex also contains a device-code flow using `/api/accounts/deviceauth/usercode`
and `/api/accounts/deviceauth/token`. The public OSS integration documentation
only specifies the browser plus loopback flow. We should not adopt Codex's
first-party client ID, connector scopes, device endpoints, or private backend
route unless OpenAI separately documents them for third-party clients.

### 2. Token contents, storage, refresh, and revocation

The authorization-code response contains:

- `access_token`
- `refresh_token` when `offline_access` is granted
- `id_token`
- `token_type`
- `expires_in`
- `scope`
- `earliest_refresh_at`

Documented lifetimes are one hour for access tokens and 30 days for refresh
tokens. Refresh tokens rotate: every successful refresh returns a replacement
refresh token with a fresh 30-day lifetime. Successive replacements have no
fixed count limit while each token remains valid.

Refresh near access-token expiry with a form-encoded POST to the same token
endpoint containing:

- `grant_type=refresh_token`
- the saved issued `client_id`
- the latest `refresh_token`
- `resource=https://api.openai.com/v1`

Omit `scope` to retain the existing grant. Serialize refresh operations for a
credential set so concurrent processes cannot race a rotating refresh token.
After success, atomically replace the access token, refresh token, expiry,
granted scopes, and any returned ID token together.

OpenAI's example credential record stores validated identity (`issuer`, `sub`,
and email), issued client ID, host ID, all three tokens, token type, expiry,
scopes, and save time. It recommends an app-defined protected local path,
atomic writes, and owner-only permissions (`0600` on Unix). Tokens must not be
placed in browser storage, URLs, source control, logs, analytics, or support
transcripts. Authorization URLs containing `id_token_hint` also require
redaction.

On sign-out, POST the current refresh token, `token_type_hint=refresh_token`, and
the issued client ID to the revocation endpoint, then clear tokens locally. A
successful revocation is an empty HTTP 200, including for an already-invalid
token. OpenAI does not currently push disconnection notifications to the app.

Terminal refresh errors include `invalid_grant`, `invalid_refresh_token`,
`token_expired`, `refresh_token_expired`, `refresh_token_invalidated`, and
`refresh_token_reused`. Clear unusable tokens and repeat OAuth with the saved
issued client ID. Transient network and 5xx failures should retain credentials
and use bounded backoff.

Codex itself supports file, secure OS keyring, automatic keyring-with-file-
fallback, and ephemeral auth stores. Its persisted ChatGPT data includes ID,
access, and refresh tokens, account ID, and last refresh. That is useful design
evidence, but this package should follow the separate OSS token contract above
rather than consume or mutate Codex's `auth.json`.

### 3. Direct backend and protocol

The documented direct backend is the public API:

- `GET https://api.openai.com/v1/models`
- `POST https://api.openai.com/v1/responses`
- `Authorization: Bearer <OAuth access token>`
- JSON content type for Responses requests

No `ChatGPT-Account-ID` header is documented for this route. That header belongs
to Codex's private ChatGPT backend flow.

Each HTTP inference request must:

- set `store: false`;
- set `stream: true`;
- send `input` as an array containing all required conversation history;
- omit `previous_response_id`;
- use `instructions` or developer messages instead of explicit system-role
  message items.

The response is the ordinary Responses API SSE event stream. Text arrives in
events such as `response.output_text.delta`. Success is established only by a
terminal `response.completed`; `response.failed`, `response.incomplete`, a
transport error, or a stream ending before `response.completed` is not success.
Usage is expected on the terminal response object.

This can be implemented directly in Node.js. There is no technical requirement
to spawn Codex CLI or Codex app-server. OpenAI separately documents app-server
as an optional stdio adapter configured with the same OAuth access token and
public Responses endpoint.

#### Codex's private backend, for comparison only

Current Codex source confirms that ChatGPT-authenticated Codex normally uses:

- base URL `https://chatgpt.com/backend-api/codex`;
- `POST /responses` with the Responses wire format;
- bearer access token plus `ChatGPT-Account-ID`;
- `GET /models?client_version=...` for its remote catalog;
- SSE events including text deltas, tool-call deltas/items, reasoning items,
  terminal completion, incomplete, and error events.

This explains prior reverse-engineered integrations, but it is not the supported
backend for this package now that OpenAI documents direct OSS plan sharing.

### 4. Models and capabilities

There is no safe static model list for the package. Available models vary by the
selected ChatGPT account, workspace, policy, and time.

Use the selected account's access token with `GET /v1/models`. The response for
this flow contains a `models` array; retain entries with `visibility == "list"`,
display `display_name`, preserve server order, and pass `slug` as the Responses
`model`. Refresh the catalog when the active account changes. A listed model is
still not an entitlement guarantee; a completed inference verifies access for
that request.

OpenAI's current inference example uses `gpt-6.1-sol`, but that is an example,
not a package default or guaranteed entitlement. Codex's bundled catalog is
also not an entitlement check.

Confirmed route-level capability constraints:

| Capability | Status for this flow |
| --- | --- |
| Text input/output | Supported |
| Streaming | Required for HTTP inference |
| Non-streaming HTTP response | Unsupported; aggregate SSE client-side |
| Function/custom tools | Supported, subject to required namespace or `additional_tools` representation |
| Web search | Conditional on model and account/workspace policy |
| Image input | Supported when the selected model accepts it |
| File input | Supported when the selected model accepts it |
| Files upload API | Unsupported |
| Audio/video input | Unsupported |
| Image generation | Unsupported |
| File search | Unsupported |
| Code Interpreter | Unsupported |
| Native computer use | Unsupported |
| Hosted MCP/connectors | Unsupported |
| Responses `tool_search` | Unsupported |
| Persistent Responses conversation state | Unsupported over HTTP |

The following request fields are explicitly unsupported and must be omitted:

`background`, `conversation`, `max_output_tokens`, `max_tool_calls`, `metadata`,
`moderation`, `multi_agent`, `prompt`, `prompt_cache_retention`,
`safety_identifier`, `temperature`, `top_logprobs`, `top_p`, `truncation`, and
`user`.

Reasoning controls/parts, JSON-schema structured output, detailed file encodings,
tool-choice variants, parallel tool calls, and exact usage metadata are not
fully specified by the OSS preview docs. They require account-backed protocol
experiments before being advertised.

### 5. AI SDK implications

Registry versions checked on 2026-10-17 were:

- `ai` 7.0.143
- `@ai-sdk/provider` 4.0.29
- `@ai-sdk/provider-utils` 5.0.62
- `@ai-sdk/openai` 4.0.96

The v0.1 implementation installs `@ai-sdk/provider`,
`@ai-sdk/provider-utils`, and `jose`; it declares AI SDK 7 as a peer dependency.
The installed `LanguageModelV4` requires `supportedUrls`, `doGenerate`, and
`doStream`. v0.1 implements `doGenerate` and makes `doStream` fail explicitly,
as required by its scope.

The current provider contract is `LanguageModelV4`. Current AI SDK source
confirms that OpenAI Responses `doStream()` sends `stream: true`, while
`doGenerate()` expects a normal JSON response and does not enable streaming.
Therefore simply configuring `@ai-sdk/openai` with the OAuth token is not enough
for `generateText()` on this route.

A direct provider remains practical:

- `doStream()` can translate Responses SSE events to
  `LanguageModelV4StreamPart` values.
- `doGenerate()` can make the same mandatory streaming request and aggregate
  text, reasoning, tool calls, finish reason, usage, headers, and provider
  metadata into `LanguageModelV4GenerateResult`.
- The prompt converter must map AI SDK system prompts to `instructions` or
  developer messages and send full history every turn.
- Unsupported generic settings should be omitted with AI SDK warnings rather
  than forwarded.
- Model IDs should remain open strings and model discovery should be a separate
  account-aware API; avoid a hard-coded union that becomes stale.

Reusing selected parsing/conversion code from `@ai-sdk/openai` may reduce work,
but its public exports, dependency cost, license obligations, and assumptions
about non-streaming generation must be reviewed before choosing that approach.

### 6. Distribution and publishing

OpenAI explicitly documents this dynamic-client flow for open-source and locally
hosted apps. It says paid or remotely hosted apps should submit the Sign in with
ChatGPT interest form. A public library can implement the OSS flow, but its docs
must not imply that every downstream commercial or hosted use is automatically
approved.

Distribution requirements and consequences:

- Do not embed or reuse Codex CLI's static OAuth client ID.
- Do not embed a client secret or partner API key; the OSS flow needs neither.
- Require the consuming app to provide its real app name for
  `agent_name_hint`. The package name is not necessarily the consuming app's
  user-facing identity.
- Give each installation/runtime a persisted host ID; do not derive it from
  email, account ID, machine name, or another identifying value.
- Keep each issued client ID bound to its validated user/workspace registration.
  Support multiple registrations even when emails match.
- Follow OpenAI's Sign in with ChatGPT UI/UX guidance: use “Continue with
  ChatGPT”, disclose when the ChatGPT plan is in use, link to ChatGPT usage
  settings, and make plan eligibility clear in downstream app UI.
- Document that Plus usage is shared across apps using the user's ChatGPT plan;
  app-specific limits and workspace policy may also apply.
- Expose exact status, error code/parameter, and request ID without logging
  secrets. Never silently fall back to another billing source.
- Treat the protocol as preview/unstable and use semver and release notes to
  identify compatibility changes.

The npm registry returned 404 for `@goravjhabakh/openai-oauth` on 2026-10-17, so no
published package currently occupies that exact name. Publication still depends
on control of the `@gorav` scope. A first scoped public release must be marked
public. Prefer npm trusted publishing/OIDC and provenance, ensure the public
repository metadata exactly matches the build source, publish only built files,
and inspect the tarball before release.

## Error behavior to preserve

Before SSE starts, direct admission may return nonstandard JSON such as
`{"detail":"..."}`. Preserve HTTP status and diagnostic text rather than
assuming the normal API error schema.

Known structured errors include:

| Code | Meaning/action |
| --- | --- |
| `subscription_sharing_user_not_eligible` | User/workspace/policy is ineligible; do not loop OAuth |
| `subscription_sharing_usage_limit_exceeded` | Stop plan-backed requests and link to ChatGPT usage settings |
| `subscription_sharing_usage_unavailable` | Temporary usage check failure; bounded backoff |
| `subscription_sharing_unsupported_capability` | Remove the field/tool/model named by `error.param` |
| `subscription_sharing_route_not_supported` | Verify method and `POST /v1/responses` route |
| `subscription_sharing_invalid_user` | Credential context failed; preserve request ID and reauthorize only after terminal auth failure |
| `chatpass_v2_scope_not_authorized` | Client/grant does not authorize the operation |
| `chatpass_v2_invalid_authorization_context` | Client/grant context is invalid |
| `subscription_sharing_user_unavailable` | Temporary user/workspace lookup failure; bounded backoff |

Admission-level 401 means signed identity/direct permission was not accepted;
403 indicates policy/permission restriction; 503 indicates unavailable or
unenabled direct routing. These bodies are diagnostic and not documented as
stable machine-readable codes.

## Experiments required before implementation claims

These experiments require a consenting test account and should capture sanitized
request/response fixtures and request IDs. Never commit tokens or personal data.

## Live v0.1 validation

Validated locally with a consenting ChatGPT account on 2026-10-17. The
credential file, host identifier, and detailed local result are ignored and were
not committed.

- First-time dynamic registration completed through the `127.0.0.1` callback.
  The saved issued client ID had the expected `oaiapp_` prefix; it was not
  `dynamic_agent_client`.
- A later authorization using the persisted registration also completed.
- The granted scope set included `chatgpt.tokens.use.direct`, `offline_access`,
  `openid`, `profile`, `email`, and `resource.invoke`. The token response
  included `earliest_refresh_at`, and ID-token validation succeeded.
- `GET /v1/models` returned seven `visibility: "list"` models for this account.
  The server-selected first model (`gpt-6.1-sol` at test time) successfully
  completed a minimal text request.
- `generateText()` aggregated the required SSE response correctly: exact text,
  stop finish reason, usage, and a response ID were present.
- After deliberately expiring the local access-token timestamp, refresh rotated
  both access and refresh tokens and the resulting credentials remained usable.
- Revocation/sign-out returned successfully and deleted the local credential
  record.

Not yet live-validated: concurrent cross-process refresh, terminal stream
failures/EOF, admission errors, and a second account or plan.

### Current implementation limitation

`OpenAIOAuth` currently deduplicates refreshes only within one instance.
`FileCredentialStore` locks individual writes, not the complete load → refresh →
save transaction, so multiple processes must not share a credential record. A
consumer that needs this topology must use separate records or provide a custom
store/coordinator with cross-process transaction locking.

### Account-backed validation preference

For future live/account-backed validation, prefer `gpt-5.6-terra` with a
medium reasoning-effort setting when that setting is within the capability
being tested. This is a test-account preference discovered from the current
account's model catalog, not a package default, entitlement guarantee, or
hard-coded model selection rule. v0.2 does not send reasoning controls, so its
streaming validation must use the model preference without forwarding effort.

### Live v0.3 validation

Validated locally with the same consenting account on 2026-10-18. No tokens,
identity data, request bodies, or response text were retained.

- The current account catalog retained seven list-visible entries in server
  order. The inspected response did not provide a stable model-specific
  capability schema suitable for public advertising.
- `gpt-5.6-terra` accepted `reasoning: { effort: "medium" }` on the public
  OAuth `/v1/responses` route with `store: false` and `stream: true`. The
  response completed successfully (request ID was not supplied in the response
  headers), and its terminal usage contained `output_tokens_details` with
  `reasoning_tokens: 0`.
- This validates only that exact model/control pair. It does not validate a
  reasoning summary request, reasoning-text SSE events, other effort values,
  or any other model. Those remain unavailable in the provider.

### Live v0.4 validation

Validated locally with the same consenting account on 2026-10-18. No tokens,
identity data, tool arguments, tool outputs, or model text were retained.

- The public OAuth `/v1/responses` route accepted ordinary top-level function
  tools with `{ type, name, description, parameters }`, `store: false`, and
  `stream: true` on `gpt-5.6-terra`.
- `auto`, `none`, `required`, and named function selection
  (`{ type: "function", name }`) were accepted. The provider maps the matching
  AI SDK choices and rejects a named choice that does not name a supplied
  function before sending a request.
- The stream supplied a `function_call` output item with distinct item `id` and
  `call_id`, argument deltas keyed by item ID, `arguments.done` with the final
  serialized JSON, and a terminal completion. The adapter uses `call_id` as the
  AI SDK tool-call ID and only emits the completed call after `arguments.done`.
- A follow-up request containing the original `function_call` and matching
  `function_call_output` by `call_id` completed. This confirms complete-history
  client tool result continuation without `previous_response_id`.
- Parallel calls, namespaced tools, `additional_tools`, strict mode, provider
  tools, and non-text/non-JSON result outputs were not tested and remain
unsupported.

### Live v0.5 validation

Validated locally with the same consenting account on 2026-10-18. No tokens,
request bodies, file contents, response text, or request IDs were retained.

- `gpt-5.6-terra` accepted Responses `text: { format: { type: "json_schema",
  name, schema, strict: true } }` with `store: false` and `stream: true` in
  both aggregated and incremental paths. A deliberately non-strict compatible
  schema lacking `additionalProperties: false` was rejected with HTTP 400.
- The model accepted both a PNG `input_image.image_url` and PNG data URL in
  both paths. The adapter therefore exposes only `image/png`, not an inferred
  image-media-type family.
- The model accepted both an `input_file.file_url` and inline text represented
  as a `text/plain` base64 data URL in both paths. The adapter exposes only
  `text/plain`; it does not upload files or accept provider references.
- Each successful request completed with the ordinary text-delta SSE sequence
  and terminal `response.completed`. JSON parsing and schema validation remain
  AI SDK responsibilities; the provider does not infer conformance from text.

### v0.2 implementation status

v0.2 implements and mock-validates incremental text streaming, response
metadata and terminal usage mapping, premature-EOF errors, and consumer
cancellation. It has not yet been validated against the current account. Before
calling the release complete, capture sanitized account-backed fixtures for the
complete event sequence, terminal usage/metadata, cancellation, terminal
failures, and interrupted streams.

1. **OAuth registration and validation**
   - Complete first registration with a generated host ID.
   - Record callback fields, token fields, scopes, expiry, and
     `earliest_refresh_at` without recording token values.
   - Validate the ID token through discovery/JWKS, including negative tests for
     nonce, audience, issuer, expiry, and callback state.
2. **Reauthorization and multi-account isolation**
   - Reauthorize using issued client ID and ID-token hint.
   - Confirm callback behavior, workspace binding, account switching, and the
     behavior when two registrations share an email.
3. **Refresh rotation and concurrency**
   - Refresh near expiry, verify replacement-token rotation and any ID-token
     behavior, and test two concurrent refresh attempts under a lock.
   - Determine how `earliest_refresh_at` should gate retries.
4. **Model discovery**
   - Capture a sanitized `/v1/models` schema for at least two account/plan types.
   - Verify ordering, visibility, capability metadata, and how catalog changes
     after account switching.
5. **Minimal generation**
   - Send text input with only `model`, `input`, `store: false`, and
     `stream: true`.
   - Capture the complete event sequence, finish data, usage, headers, and
     interrupted-stream behavior.
6. **AI SDK `generateText()` compatibility**
   - Aggregate the same SSE stream and compare expected `LanguageModelV4`
     semantics for text, usage, finish reason, cancellation, and errors.
7. **Prompt role mapping**
   - Verify `instructions` and developer messages.
   - Confirm explicit system message items are rejected as documented.
8. **Unsupported-option matrix**
   - Verify representative rejected fields and map each AI SDK option to omit,
     warning, or support.
9. **Tools**
   - Test namespaced function/custom tools, `additional_tools`, tool choice,
     parallel calls, streaming argument deltas, and multi-step tool results.
   - Determine whether the AI SDK's ordinary top-level function-tool encoding
     is accepted unchanged.
10. **Reasoning and structured output**
    - Test supported reasoning effort/summary values per returned model.
    - Test `text.format` JSON schema and streamed structured output before
      claiming `generateObject`/`Output.object` support.
11. **Rich inputs**
    - Test image URL, inline image, inline file, and provider file references.
    - Confirm behavior without the unsupported Files upload API.
12. **Revocation and disconnect**
    - Verify revocation response and subsequent refresh/inference errors.
13. **Storage durability**
    - Test atomic replacement, restrictive permissions, crash recovery, corrupt
      records, and cross-process refresh locking on Windows, macOS, and Linux.

## Unresolved product decisions

1. **Credential ownership:** Should the package ship a Node file store, require a
   caller-supplied store, or provide both? A default file store is convenient
   but carries security and cross-process locking responsibilities. A keyring
   default adds platform dependencies and failure modes.
2. **Package boundary:** Should OAuth helpers and the AI SDK provider be one
   public entrypoint or separate exports? Authentication is useful independently
   of model invocation, but premature package splitting would add complexity.
3. **Host lifecycle:** What exactly constitutes one host for this library, and
   where should its stable host ID live when several apps share the dependency?
   The consuming app, not the library package, should likely own this identity.
4. **App identity:** The provider factory needs the consuming app's actual name;
   silently using `@goravjhabakh/openai-oauth` would misidentify downstream apps during
   consent.
5. **Commercial/hosted consumers:** Package documentation needs a firm support
   boundary for downstream paid or remotely hosted deployments that require
   OpenAI engagement.
6. **`generateText()` behavior:** Aggregating a mandatory stream is feasible,
   but partial output and late `response.failed` semantics need an explicit
   policy consistent with AI SDK expectations.
7. **Dependency strategy:** Decide whether to depend on `@ai-sdk/openai`, reuse
   only public provider utilities, or implement the narrow Responses mapping.
   Current evidence favors the narrow direct implementation, but this should be
   decided after protocol fixtures exist.
8. **Model API surface:** Decide whether model discovery belongs in the provider,
   auth client, or a separate account client. It must remain account-aware and
   dynamic.

## Evidence

Primary OpenAI documentation, accessed 2026-10-17:

- [OSS plan-sharing overview](https://developers.openai.com/siwc/token-sharing-open-source)
- [Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [Accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
- [Token reference](https://developers.openai.com/siwc/token-sharing-open-source/token-reference)
- [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
- [Errors and recovery](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery)
- [Codex app-server option](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)
- [UI/UX guidelines](https://developers.openai.com/siwc/ui-ux-guidelines)
- [OIDC discovery](https://auth.openai.com/.well-known/openid-configuration)

Primary source snapshots inspected:

- OpenAI Codex commit
  [`ce0323f`](https://github.com/openai/codex/tree/ce0323f2f2d3b25e82806cd555237da3db4e1897):
  login server, auth manager/storage, token data, model-provider configuration,
  models endpoint, Responses request/SSE handling, and tests.
- Vercel AI SDK commit
  [`fce9210`](https://github.com/vercel/ai/tree/fce9210c6405c0ad8452fee3f50717e8ea910b97):
  `LanguageModelV4`, custom-provider documentation, and OpenAI Responses
  `doGenerate`/`doStream` implementations.
- [npm provenance documentation](https://docs.npmjs.com/generating-provenance-statements)

Source-code findings describe those exact revisions. OpenAI's published SIWC
documentation controls the supported third-party integration path.

## Architecture Decisions

- Credential storage: interface + built-in Node file store.
- Package boundary: one package, `@goravjhabakh/openai-oauth`.
- App/host identity: owned by the consuming application.
- Dependencies: use `@ai-sdk/provider` and `@ai-sdk/provider-utils`; do not depend on `@ai-sdk/openai` initially.

### v0.6 package validation

On 2026-10-18, the generated tarball was inspected and contained only emitted
ESM/declaration files, README, and package metadata. An independent temporary
pnpm consumer installed that tarball, type-checked root imports, and executed
offline mocked catalog, generation, and streaming calls. This validates package
wiring only; it adds no account-backed capability evidence.

### Final v1.0 packed-consumer validation

Validated locally with the same consenting account on 2026-10-18. The package
was packed, installed into an independent temporary pnpm consumer fixture, and
used only through its public root exports; no repository source or `dist` import
was used. The fixture created and deleted its own credential directory.

- Browser sign-in, account model listing (seven list-visible models), preferred
  `gpt-5.6-terra` selection, and sign-out/revocation completed successfully.
- AI SDK `generateText()` and `streamText()` completed with non-empty text.
- The validated medium reasoning option, strict `Output.object()` structured
  output, and a function-tool call followed by application-executed result
  continuation all completed successfully.
- PNG URL and inline inputs plus `text/plain` URL and tagged inline-text inputs
  completed successfully. AI SDK defines a bare string file value as base64 data;
  plain inline text must use `{ type: "text", text }`, which is now called out
  in the README.
- The final `pnpm validate:consumer:live` release-readiness run repeated this
  opt-in packed-consumer check successfully. It intentionally remains outside
  `release-check` because browser consent and a billable/plan-backed account
  are required.

### v1.0.2 published-package consumer validation

Validated in a fresh external AI SDK consumer against the published package on
2026-10-18. The smoke validation completed medium reasoning on `gpt-5.6-terra`,
function-tool continuation, `Output.object()` structured output, a known-valid
inline PNG, tagged inline `text/plain` input, and sign-out. An earlier PNG
rejection was traced to invalid test image bytes; the successful known-valid PNG
does not indicate a provider image-handling defect.

### npm trusted-publishing readiness

Verified against npm's trusted-publishing documentation on 2026-10-18:

- GitHub Actions trusted publishing requires a GitHub-hosted runner,
  `id-token: write`, npm CLI 11.5.1 or later, and Node.js 22.14.0 or later.
- For a public package from a public repository, npm automatically produces
  provenance for a successful OIDC trusted publish; the workflow must not use
  a long-lived npm publishing token or pass `--provenance`.
- The npm trusted publisher must exactly name the GitHub owner, repository,
  workflow filename, and, when used, GitHub Environment. A newly configured
  trusted publisher expires if it does not complete a first successful publish
  within two days.

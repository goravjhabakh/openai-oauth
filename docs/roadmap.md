# Roadmap

## Research and Validation

Before implementation, understand:

- validate OAuth behavior with a real test account
- capture sanitized Responses API fixtures
- verify model discovery
- verify `generateText()` stream aggregation
- verify prompt-role mapping
- verify basic error behavior

## v0.1 — Basic Generation — Complete

- provider factory
- authentication
- `LanguageModelV4`
- text input
- `generateText()`
- basic errors
- usage data where available

## v0.2 — Streaming — Implementation Complete; Account-Backed Validation Pending

- `streamText()`
- incremental stream parsing
- finish and usage events
- cancellation
- stream errors

## v0.3 — Provider Features — In Progress

- reasoning options
- model capabilities
- provider metadata
- unsupported-option warnings
- improved error handling

The core implemented surface includes the account-aware capability catalog, safe
provider metadata, centralized unsupported-option warnings, and the one
account-backed validated reasoning option (`gpt-5.6-terra` with medium effort).
Account-backed validation remains incomplete for streaming cancellation,
interrupted streams, and terminal error cases.

## v0.4 — Tools — Complete

If the backend supports the required behavior cleanly:

- account-backed validated AI SDK function tools and tool choice
- streamed argument and completed tool-call mapping
- complete-history tool-result continuation

## v0.5 — Richer Inputs and Output — Complete

- structured output
- image input
- file input where supported
- additional metadata where useful

The provider supports only the account-backed validated `gpt-5.6-terra` forms:
JSON-schema output, PNG URL/data images, and plain-text URL/inline inputs.

## v1.0 — Stable Language Model Provider

- stable public API
- reliable authentication lifecycle
- generate + stream
- tested capability matrix
- documentation and examples
- publishable package

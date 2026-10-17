# AGENTS.md

## Purpose

This file defines how AI coding agents should work in this repository.

For project context, read:

- `docs/project.md`
- `docs/roadmap.md`
- `docs/research.md`
- `docs/architecture.md`

Read version-specific docs when they exist and are relevant to the task.

## Working Style

- Treat the developer as someone learning through the project.
- Explain important design decisions and tradeoffs.
- Work in small, coherent batches.
- Present the approach before implementing large changes.
- Prefer simple solutions over premature abstraction.
- Ask questions when an important decision is unclear.
- Challenge weak assumptions when needed.
- Do not hide uncertainty behind confident assumptions.

## Research Behavior

When working with OpenAI OAuth, Codex behavior, AI SDK internals, or other fast-changing APIs:

- verify current behavior
- prefer official documentation and primary source code
- use `gh_grep` for source-code investigation
- use Firecrawl for current documentation, issues, and supporting research
- distinguish confirmed facts from assumptions
- record important findings in `docs/research.md`
- never invent endpoints, payloads, authentication behavior, or model support

## AI SDK

Use the installed Vercel AI SDK skill when working with AI SDK APIs, provider interfaces, or implementation details.

Prefer inspecting the current installed AI SDK version and its source/docs over relying on model memory.

## Implementation Rules

- TypeScript
- Node.js first
- pnpm only
- use Vercel AI SDK provider interfaces directly
- prefer `@ai-sdk/provider` and `@ai-sdk/provider-utils` where appropriate
- minimize dependencies
- build vertical end-to-end slices
- add meaningful tests
- avoid unnecessary abstractions

## Documentation Rules

- Keep docs simple, concise, and complete.
- Update existing docs instead of creating a file for every small detail.
- Put stable project context in `docs/project.md`.
- Put direction and versions in `docs/roadmap.md`.
- Put verified findings, experiments, and open questions in `docs/research.md`.
- Create version-specific specs only when implementation planning begins.
- Put stable technical design and component boundaries in `docs/architecture.md`.

## Repository Conventions

- Package manager: pnpm
- Package: `@gorav/openai-oauth`
- Source: `src/`
- Documentation: `docs/`

## Tools

Available project tooling includes:

- Vercel AI SDK skill
- Firecrawl MCP
- `gh_grep` MCP
- Playwright MCP

Use them when they materially improve the task.

Do not assume other tools are available unless they are configured in the environment.

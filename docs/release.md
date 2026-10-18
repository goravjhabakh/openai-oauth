# Releasing

This repository publishes `@goravjhabakh/openai-oauth` through npm trusted publishing.
The GitHub Actions workflow exchanges its short-lived OIDC identity with npm;
do not add `NPM_TOKEN`, `NODE_AUTH_TOKEN`, or another long-lived publishing
credential to the repository or its Actions secrets.

## One-time configuration

### npm

An authorized `@gorav` maintainer must configure the package at npmjs.com:

1. Confirm ownership of the `@gorav` scope and maintainership of
   `@goravjhabakh/openai-oauth`.
2. In **Package settings → Trusted publishing**, add a GitHub Actions publisher
   with these exact values:
   - Organization or user: `goravjhabakh`
   - Repository: `openai-oauth`
   - Workflow filename: `publish.yml`
   - Environment name: `npm`
   - Allowed action: permit `npm publish`
3. Complete the first trusted publish within two days of creating that
   configuration; npm expires an unvalidated configuration after that period.
4. After a successful OIDC publish, set **Publishing access** to require 2FA
   and disallow traditional tokens, then revoke obsolete automation tokens.

The trusted publisher configuration and `package.json` repository URL are
case-sensitive and must match exactly. The package must be public and the
repository public for npm to generate provenance automatically.

### GitHub

1. Create the repository Environment named `npm`.
2. Require approval from a maintainer for that environment. Do not grant it
   environment secrets: OIDC publishing needs none.
3. Protect the `v*` tag pattern with a ruleset so only authorized maintainers
   can create release tags.

The workflow runs only on a `v*` tag in `goravjhabakh/openai-oauth`, uses a
GitHub-hosted runner, and requires the tag to equal `v${package.json.version}`.

## Release procedure

1. Start from the intended release commit with a clean working tree.
2. Confirm the version and run the required checks:

   ```bash
   pnpm release-check
   pnpm validate:consumer:live
   ```

3. Create and push the matching annotated tag. For the current release:

   ```bash
   git tag -a v1.0.0 -m "v1.0.0"
   git push origin v1.0.0
   ```

4. Open the **Publish to npm** workflow run and approve its `npm` environment.
   The workflow runs the release check again, verifies the tag/version match,
   then executes:

   ```bash
   npm publish --access public
   ```

   Do not publish from a workstation and do not pass `--provenance`: npm
   automatically creates provenance for a public package published through this
   trusted GitHub Actions workflow.

5. Confirm the npm package page reports the expected version, public access,
   repository metadata, and provenance. Then create the GitHub Release from the
   already-published `v1.0.0` tag.

If npm rejects OIDC authentication, verify the exact repository, workflow
filename, environment name, `id-token: write` permission, and GitHub-hosted
runner before changing any credentials.

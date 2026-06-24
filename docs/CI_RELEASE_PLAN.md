# CI Auto-Release Plan

## Overview

Use a tag-triggered GitHub Actions workflow to publish `pi-questionnaire` to npm.

Release trigger:

- A maintainer bumps `package.json` version, updates release notes/changelog, commits to `master`, creates a tag like `v2.0.2`, and pushes the commit plus tag.
- GitHub Actions runs validation on GitHub-hosted `ubuntu-latest` runners.
- Node tests and pytest run in parallel to reduce wall-clock time.
- The publish job waits for both test jobs, rebuilds the package, and runs `npm publish --provenance --access public`.
- npm authentication uses Trusted Publishing / OIDC. No long-lived `NPM_TOKEN` secret is needed.

What gets published:

- The public, unscoped npm package `pi-questionnaire`.
- Package contents are controlled by `package.json` `files` plus `.npmignore`.
- The current package includes `dist`, `README.md`, `CHANGELOG.md`, and `LICENSE`.

## Proposed `.github/workflows/release.yml`

```yaml
name: Release

on:
  push:
    tags:
      - 'v*'

permissions:
  contents: read

jobs:
  node-tests:
    name: Node tests
    runs-on: ubuntu-latest

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup pnpm
        uses: pnpm/action-setup@v4
        with:
          version: 9.15.9
          run_install: false

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: '22.14'
          cache: pnpm
          cache-dependency-path: pnpm-lock.yaml

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Build
        run: pnpm run build

      - name: Run Node test suite
        run: pnpm test

  pytest:
    name: Python pytest suite
    runs-on: ubuntu-latest

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup pnpm
        uses: pnpm/action-setup@v4
        with:
          version: 9.15.9
          run_install: false

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: '22.14'
          cache: pnpm
          cache-dependency-path: pnpm-lock.yaml

      - name: Setup Python
        uses: actions/setup-python@v5
        with:
          python-version: '3.12'

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Build
        run: pnpm run build

      - name: Run pytest suite
        run: python3 -m pytest tests/ -q

  publish:
    name: Publish to npm
    runs-on: ubuntu-latest
    needs:
      - node-tests
      - pytest

    permissions:
      contents: read
      id-token: write

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup pnpm
        uses: pnpm/action-setup@v4
        with:
          version: 9.15.9
          run_install: false

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: '22.14'
          registry-url: 'https://registry.npmjs.org'
          cache: pnpm
          cache-dependency-path: pnpm-lock.yaml

      - name: Ensure npm supports Trusted Publishing
        run: |
          npm install -g npm@^11.5.1
          node --version
          npm --version

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Verify tag matches package version
        run: |
          PACKAGE_VERSION="$(node -p "require('./package.json').version")"
          test "$GITHUB_REF_NAME" = "v$PACKAGE_VERSION"

      - name: Build
        run: pnpm run build

      - name: Publish package
        run: npm publish --provenance --access public
```

### Important implementation note about `prepublishOnly`

Current `package.json` has:

```json
"prepublishOnly": "npm run build && npm run test:all"
```

That means `npm publish --provenance --access public` will run `build` plus the full serial `test:all` again inside the publish job. This is safe, but it partially defeats the parallel-test speedup.

Recommended follow-up before landing the workflow:

- Keep CI as the release gate.
- Change `prepublishOnly` to `npm run build`, or remove the test portion from `prepublishOnly`.
- Do not use `npm publish --ignore-scripts` unless there is a deliberate decision to bypass package lifecycle scripts.

## `RELEASING.md` Outline

Add a `RELEASING.md` file with these sections.

### 1. Pre-release checklist

Include:

- Confirm working tree is clean.
- Confirm target branch is `master` and up to date with GitHub.
- Run local validation if practical:
  - `pnpm install --frozen-lockfile`
  - `pnpm run build`
  - `pnpm test`
  - `python3 -m pytest tests/ -q`
- Review and update `CHANGELOG.md` / release notes.
- Confirm `package.json` metadata is correct.
- Confirm package contents with `npm pack --dry-run`.
- Confirm the release version does not already exist:
  - `npm view pi-questionnaire versions --json`

### 2. How to cut a release

Include:

1. Decide the next semver version.
2. Update `package.json` version.
3. Update `CHANGELOG.md` / `RELEASE_NOTES.md`.
4. Commit the release prep:
   - `git add package.json CHANGELOG.md RELEASE_NOTES.md`
   - `git commit -m "chore: release vX.Y.Z"`
5. Tag the exact release commit:
   - `git tag vX.Y.Z`
6. Push commit and tag:
   - `git push origin master`
   - `git push origin vX.Y.Z`
7. Watch the GitHub Actions `Release` workflow.
8. Do not publish manually unless CI is broken and the manual publish path has been reviewed.

### 3. How to verify after release

Include:

- Check npm metadata:
  - `npm view pi-questionnaire@X.Y.Z version`
  - `npm view pi-questionnaire@X.Y.Z dist.tarball`
  - `npm view pi-questionnaire@X.Y.Z dist.integrity`
- Confirm provenance is visible on npmjs.com.
- Install in a temporary test project:
  - `mkdir /tmp/pi-questionnaire-release-smoke`
  - `cd /tmp/pi-questionnaire-release-smoke`
  - `npm init -y`
  - `npm install pi-questionnaire@X.Y.Z`
- Smoke-test importing the package if practical.
- Confirm GitHub release/tag points to the intended commit.

### 4. Hotfix procedure

Include:

- Branch from the latest released tag or `master`, depending on where the fix applies.
- Apply the smallest safe fix.
- Add or update regression tests.
- Run validation.
- Bump patch version.
- Update changelog with a hotfix note.
- Commit, tag `vX.Y.Z`, push, and let CI publish.

### 5. Rollback / yank procedure

Include:

- Prefer publishing a fixed follow-up version over unpublishing.
- If the version is actively harmful and within npm's unpublish policy window, use:
  - `npm unpublish pi-questionnaire@X.Y.Z`
- If unpublish is not appropriate, deprecate instead:
  - `npm deprecate pi-questionnaire@X.Y.Z "Broken release; use X.Y.Z+1"`
- Document the incident and the replacement version in `CHANGELOG.md`.
- Never move an already-pushed release tag without explicit maintainer approval.

## `CLAUDE.md` / `AGENTS.md` Addition

Add this short paragraph to the repo instructions file used by future agents:

> For any feature release or package publication, follow `RELEASING.md`. Do not publish manually by default. Prepare the version/changelog/tag as documented, push the `v*` tag, and let the GitHub Actions release workflow publish through npm Trusted Publishing. If CI release fails, diagnose and fix the workflow or package state before considering a manual publish.

## Manual GitHub / npm Setup Steps

The user needs to perform these setup steps outside the repository.

1. On npmjs.com, enable Trusted Publishing for `pi-questionnaire`.
2. Configure the trusted publisher to match this repository and workflow:
   - npm package: `pi-questionnaire`
   - repository owner/name: `clankercode/pi-questionnaire`
   - workflow filename: `release.yml`
   - environment: leave unset unless the workflow later adds a GitHub Environment
3. Do not add an `NPM_TOKEN` secret. OIDC handles publish authentication.
4. In GitHub repository settings, configure branch protection for `master` if not already configured:
   - Require pull request review or explicit maintainer process, if desired.
   - Require status checks for normal branches.
   - Prevent accidental force-pushes.
5. Confirm Actions are enabled for the repository.

## Node Version Note

Local development can stay on the maintainer's normal Node version as long as it satisfies the package's runtime and development needs. The current package declares:

```json
"engines": {
  "node": ">=18"
}
```

CI release publishing should still use Node `22.14` or newer because npm Trusted Publishing requires Node `>=22.14` and npm `>=11.5.1` for OIDC publishing.

This creates an intentional discrepancy:

- Runtime package support remains `node >=18` unless the project decides otherwise.
- Release CI uses Node `22.14+` only for the publisher toolchain.
- The workflow explicitly upgrades npm to `^11.5.1` before publishing so it does not depend on the runner's bundled npm version.

## Open Questions / Gotchas

- Should `prepublishOnly` be changed from `npm run build && npm run test:all` to `npm run build` once CI has parallel release gates? Keeping it as-is is safer but slower.
- Should `package.json` add a `packageManager` field such as `pnpm@9.15.9` so local and CI installs use the same pnpm version?
- Should release notes live in `CHANGELOG.md`, `RELEASE_NOTES.md`, or both? `RELEASING.md` should make this single source of truth explicit.
- Should GitHub Releases be created automatically after npm publish, or is the pushed git tag enough for now?
- Should branch protection require the release workflow checks before merging release prep commits to `master`?
- Confirm npm Trusted Publishing accepts the unscoped public package configuration exactly as expected after setup.

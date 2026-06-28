# pi-questionnaire — common tasks
# (repo norm: a justfile manages common scripts)

# Run all tests.
test:
    npm test

# Build TypeScript + copy browser assets.
build:
    npm run build

# Full CI gate: build + test.
ci: build test

# Install deps.
install:
    npm install

# Cut a release: gate, bump package.json, commit, tag, and push.
# Pushing the vX.Y.Z tag triggers .github/workflows/release.yml, which
# re-runs the gate, publishes to npm (OIDC trusted publishing), and creates
# the GitHub Release. VERSION is an explicit semver (e.g. 2.2.0) or an
# increment npm understands (patch | minor | major).
release VERSION:
    #!/usr/bin/env bash
    set -euo pipefail
    if ! git diff --quiet || ! git diff --cached --quiet; then
        echo "working tree is not clean — commit or stash first" >&2
        exit 1
    fi
    branch="$(git rev-parse --abbrev-ref HEAD)"
    if [ "$branch" != "master" ]; then
        echo "releases are cut from master, not '$branch'" >&2
        exit 1
    fi
    just ci
    tag="$(npm version "{{VERSION}}" -m "chore: release %s")"
    git push origin master
    git push origin "$tag"
    echo "Pushed $tag — CI will publish to npm and create the GitHub Release."

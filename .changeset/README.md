# Changesets

Every change that should ship to npm needs a changeset. Run `bun run changeset`,
pick the bump (patch, minor, major), and describe the change for the changelog.

When changesets land on `master`, the release workflow opens a "Release" pull
request that applies them: it bumps the version and writes `CHANGELOG.md`.
Merging that pull request publishes the new version to npm.

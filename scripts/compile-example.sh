#!/usr/bin/env bash
# Compile the example workflow to WASM against the packed library, the way a
# user's workflow consumes it.
#
# `cre-compile` validates only a workflow's own files, never its dependencies,
# so this is the one check that runs this package through the real CRE compile
# pipeline: bundling, the Javy plugin, and the WASM build.
#
# CRE_SDK_VERSION picks the @chainlink/cre-sdk the workflow installs. It
# defaults to the version this repo develops against.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cre_sdk_version="${CRE_SDK_VERSION:-$(node -p "require('$root/package.json').devDependencies['@chainlink/cre-sdk']")}"
zod_version="$(node -p "require('$root/package.json').devDependencies.zod")"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

echo "Packing the library"
tarball="$(cd "$root" && npm pack --silent --pack-destination "$work" | tail -n 1)"

echo "Creating a workflow project with @chainlink/cre-sdk@$cre_sdk_version"
mkdir "$work/workflow"
cat > "$work/workflow/package.json" <<EOF
{
  "name": "compile-example",
  "private": true,
  "type": "module",
  "dependencies": {
    "@chainlink/cre-sdk": "$cre_sdk_version",
    "@tenderly/cre-preflight": "file:$work/$tarball",
    "zod": "$zod_version"
  }
}
EOF
cat > "$work/workflow/tsconfig.json" <<'EOF'
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "lib": ["ESNext"]
  },
  "include": ["main.ts"]
}
EOF
cp "$root/examples/preflight-workflow/workflow.ts" "$work/workflow/main.ts"

cd "$work/workflow"
bun install
bunx cre-compile main.ts main.wasm

test -s main.wasm
echo "Compiled the example workflow: $(wc -c < main.wasm | tr -d ' ') bytes of WASM"

#!/bin/bash
# Cloud-environment setup for the runtime-clock dispatch. Paste this into the environment's
# Setup script field; it runs once, before Claude Code launches.
#
# The trusted entry verifies five package trees file by file against RuntimeDependencyManifest
# .json, and apps/clued-cloud/node_modules is gitignored -- so a fresh clone has none of them and
# the entry refuses with RUNTIME_DEPENDENCY_PACKAGE_TREE_DRIFT before anything runs.
#
# `npm ci` cannot recreate them: package.json and package-lock.json are out of sync in this repo
# (gcp-metadata and google-logging-utils are missing from the lock), so it refuses outright.
# ajv@6.15.0's dependencies are exactly the other four pinned packages, so installing it alone in
# an isolated directory produces all five and nothing else. Verified on 2026-09-15: the result is
# byte-identical to the trees the manifest pins, and the entry passes on it.
set -euo pipefail

REPO=/home/user/cross-memory-system
[ -d "$REPO/apps/clued-cloud" ] || REPO="$(pwd)"
DEST="$REPO/apps/clued-cloud/node_modules"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cd "$TMP"
npm init -y >/dev/null
npm install --ignore-scripts --no-audit --no-fund ajv@6.15.0 >/dev/null

mkdir -p "$DEST"
for package in ajv fast-deep-equal fast-json-stable-stringify json-schema-traverse uri-js; do
  rm -rf "$DEST/$package"
  cp -R "$TMP/node_modules/$package" "$DEST/"
done

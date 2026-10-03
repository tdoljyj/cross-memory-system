#!/bin/sh
# Linux runner wrapper for clued-runner-job-started.mjs (see README.md).
exec "${CLUED_RUNNER_HOOK_NODE:-node}" "$(dirname "$0")/clued-runner-job-started.mjs"

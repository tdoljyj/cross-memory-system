// The tests of the local developer tools in scripts/ci, which no required
// suite ran before: the pre-push preflight and local verification.
import '../../../scripts/ci/pr-repush-preflight.test.mjs';
import '../../../scripts/ci/local-verify.test.mjs';
import '../../../scripts/ci/main-entry-realpath.test.mjs';
import '../../../scripts/ci/setup-clued-dev-linux.test.mjs';
import '../../../scripts/ci/self-hosted/node-governance/governance.test.mjs';
import '../../../scripts/ci/local-verify-concurrency.test.mjs';

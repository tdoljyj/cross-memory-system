// Run the exact publisher Source/Role and historical admission regressions
// through the established quality unit entry, before any consumer installation.
import '../../../scripts/ci/clued-production-publisher-source.test.mjs';
import '../../../scripts/ci/clued-publisher-qualification-source.test.mjs';
import '../../../scripts/ci/merge-admission-source-producer.test.mjs';
import '../../../scripts/ci/merge-admission-natural-frame.test.mjs';

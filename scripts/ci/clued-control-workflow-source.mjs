// Exact historical reporter/controller Sources plus the initial reconciliation controller. Event payloads are data;
// these are neither candidate application tests nor publisher qualifications.
import {createHash} from 'node:crypto';
import {roleDefinitionDigest,workflowBlob} from './clued-workflow-profile.mjs';

export const COMPONENT_VERSION='1.0.8';
export const CONTROL_WORKFLOW_SOURCE_PATH='scripts/ci/clued-control-workflow-sources.json';
export const CONTROL_WORKFLOW_SOURCE_SCHEMA='clued.control-workflow-sources/1';
export const CONTROL_WORKFLOW_SOURCE_COMMIT='080ff04a8109ee74c53f16b79123fd55430cb7be';
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
// New exact source candidate only; this does not authorize a hosted run,
// install, secret access or a migration of any controller route.
export const SLOT_COMPLETION_OBSERVER_SOURCE=freeze({
  "file": ".github/workflows/clued-merge-slot-ci.yml",
  "workflow_blob": "759fd82dc328fba0aa663e2c6c8c9aa516292294",
  "source_sha256": "670c8e3bee253df7811cf35699213d94d548698178e3e1fb1a5789399c63b261",
  "workflow_definition_sha256": "5632cf17910db27a746ed159a04813b20c1c3d1c5d9923e3215568cc6ba05523",
  "role_digests": {
    "report": "becc90f293b687326328f684eae049bd17985ef259db9db6bf501f7ad027b63d"
  },
  "implementation_blobs": {
    ".github/actions/ci-temporary-storage/action.yml": "72a78ada2553dc42a062dbccf310d1b23e65431f",
    ".github/actions/ci-temporary-storage/setup.mjs": "dd162105b2800d31b9970d25575945a140a69d42",
    ".github/actions/ci-temporary-storage/setup.py": "4e3f82e061162f894e310f6e767bacf8c57a079b",
    "apps/clued-cloud/app/supabase-public-config.ts": "193fedd8e9d5ccaea873e2cc4d0efd894e93d6ae",
    "config/merge-admission-policy.json": "a54ea27028f6361765fffce30f9ffa227a91b2ea",
    "scripts/ci/ci-required-selection.mjs": "12fbf6e1a14b5e9a9b986ed0dbbb6c5a99271e5a",
    "scripts/ci/clued-docs-only.py": "395f086b58ea3ff6cb5946660da734cc5072938f",
    "scripts/ci/clued-gated-proof-profiles.json": "ef4270fd72819d3f4cbab5ddb4484426e337f720",
    "scripts/ci/clued-gated-proof-role-specs.json": "81f2a2bed2113dde22f260733234f954180ac0c6",
    "scripts/ci/clued-gated-proof-runtime.mjs": "c1c76dc8421297a25ce371c23171a0b3f6690908",
    "scripts/ci/clued-gated-proof.mjs": "d92a4cbec0992e16a7c69ded5540be1f40c2d39a",
    "scripts/ci/clued-managed-auto-merge.mjs": "738e887104de888abc9bd63f2d86a135a891ffb8",
    "scripts/ci/clued-merge-executor.mjs": "d337e8057026fbfa5a2151825562205558a7e850",
    "scripts/ci/clued-merge-executor.test.mjs": "33e38adb2cd83463976cfd500ba32a34014a6f36",
    "scripts/ci/clued-merge-slot-ci.mjs": "69c40e7aa897b352293fa8ef43ded843c0f0b191",
    "scripts/ci/clued-merge-slot-ci.test.mjs": "900c7496bef6edd4f45b67c2444f991a984bda25",
    "scripts/ci/clued-non-pr-control-source.mjs": "1bb822b1fb821bfd651bd27b454308ded2be61c2",
    "scripts/ci/clued-non-pr-control-sources.json": "3d447c3155aa3fa8c63a42adc9187a1fdb4985d7",
    "scripts/ci/clued-production-publisher-source.mjs": "0e3c2d4df3fb2f4ceb6ec8750028e2b046a1a0b6",
    "scripts/ci/clued-production-publisher-sources.json": "df10a840de4d00961d9df55103e6c6849fba23fb",
    "scripts/ci/clued-publisher-qualification-source.mjs": "f38859449e35eeeef492db8130f91c266c208d75",
    "scripts/ci/clued-publisher-qualification-sources.json": "34bbd3c400af8565ed28545af2ba839c5f920d40",
    "scripts/ci/clued-required-applicability.mjs": "19d8ac176b4708f2976bbaaae816ad2f4a43b1d4",
    "scripts/ci/clued-source-only-workflow.mjs": "ab784bff64ac4caaad473ffe728e391997df6594",
    "scripts/ci/clued-work-admission.mjs": "c23db774a37360a7aa18b5b1de83a6751c499d3b",
    "scripts/ci/clued-workflow-profile.mjs": "69622ceef577da9e4eb8dab25fed4bdc1cbb50f3",
    "scripts/ci/merge-admission-measurement-history.mjs": "6799c148ee7baf51a5ba989de73fb8bffb054f6f",
    "scripts/ci/merge-admission-policy.mjs": "a3f6830e0087474d3e36222d12975deb7830c4d3",
    "scripts/ci/merge-admission-source-producer.mjs": "2f428d400de4dbf0a9feca2bd27269c0dd353033",
    "scripts/ci/test_clued_docs_only.py": "509cf8c428349a13d979584e3493435445defa27",
    "scripts/runner/clued-runner-job-started.mjs": "dd6dcaf875539c23a9e87726542de8179a81456a"
  }
});
export const PUBLIC_REPORTER_CONTROLLER_ROUTE=freeze(['self-hosted','Linux','X64','clued','pool-general','trust-internal']);
const temporaryStorageBlobs={
  '.github/actions/ci-temporary-storage/action.yml':'72a78ada2553dc42a062dbccf310d1b23e65431f',
  '.github/actions/ci-temporary-storage/setup.mjs':'dd162105b2800d31b9970d25575945a140a69d42',
  '.github/actions/ci-temporary-storage/setup.py':'4e3f82e061162f894e310f6e767bacf8c57a079b',
};
export const REPORTER_CONTROL_WORKFLOW_FILES=freeze({
  '.github/workflows/public-mcp-gate-receipt.yml':{
    family:'workflow_run_status_reporter',migrating_job:'untrusted-hosted',
    predecessor_blob:'3a6afbeeee101dd1d1cfb9c9ed24e8d9c661f2d9',
    predecessor_sha256:'fc54bcd40eb36fbc41e022b2aa410f486c893304ae689363edbae6dc86dff4f2',
    predecessor_definition_sha256:'19e5596d0c0f153347de8cfbbf4a206e9664269b8c8e6c0d6c820ff520569ecf',
    implementation_blobs:{'apps/clued-cloud/evals/public-mcp/gate-receipt.mjs':'823c3ef573d90745de1471018cc861a392be53c8',
      'scripts/runner/clued-runner-job-started.mjs':'f1355a6592f8cdfe1a007d461c57296f0525dbbf',...temporaryStorageBlobs},
  },
  '.github/workflows/memory-publication-gate.yml':{
    family:'pull_request_target_blob_verifier',migrating_job:'untrusted-hosted',
    predecessor_blob:'02988b3be31122457485e1ba6189a71e70de8d54',
    predecessor_sha256:'6aa417be2389d3f0195ab6540bab27b336fa3287a9c3586daa564bdd9c3db207',
    predecessor_definition_sha256:'8f0a6808d4f6602cf85f6fc557546277fe6bbf350291cc82c9022ec6f70a79a7',
    implementation_blobs:{'scripts/verify-memory-publication.mjs':'30970cc54bbc84fafacc07b353548f8478228bc3',...temporaryStorageBlobs},
  },
});
export const MAIN_SECRET_CONTROLLER_ROUTE=freeze(['self-hosted','Windows','X64','clued-controller-windows-v1']);
export const MAIN_SECRET_CONTROL_WORKFLOW_FILES=freeze({
  ".github/workflows/clued-work-admission.yml": {
    "family": "trusted_main_secret_controller",
    "migrating_jobs": [
      "clued-work-admission",
      "clued-work-adopt"
    ],
    "predecessor_blob": "19e67fd3b6b706b3c957506a7bfce6d8aeb7fd3b",
    "predecessor_sha256": "179c8d03e72c4d4a99c22b723ef92fc480cbf019f82fceda954100e9e0816a01",
    "predecessor_definition_sha256": "799919e9bc6f1ff5ec0332aff632d15f9963d5d9e36a98618823bec8dc41282a",
    "implementation_blobs": {
      ".github/actions/ci-temporary-storage/action.yml": "72a78ada2553dc42a062dbccf310d1b23e65431f",
      ".github/actions/ci-temporary-storage/setup.mjs": "dd162105b2800d31b9970d25575945a140a69d42",
      ".github/actions/ci-temporary-storage/setup.py": "4e3f82e061162f894e310f6e767bacf8c57a079b",
      "scripts/ci/clued-work-admission.mjs": "0e53b628735cb5cbd90ef2f61ab999e46350f385",
      "scripts/ci/merge-admission-policy.mjs": "a3f6830e0087474d3e36222d12975deb7830c4d3",
      "scripts/ci/merge-admission-measurement-history.mjs": "6799c148ee7baf51a5ba989de73fb8bffb054f6f",
      "scripts/ci/merge-admission-source-producer.mjs": "2f428d400de4dbf0a9feca2bd27269c0dd353033",
      "scripts/runner/clued-runner-job-started.mjs": "f1355a6592f8cdfe1a007d461c57296f0525dbbf",
      "scripts/ci/clued-workflow-profile.mjs": "c7b1f0f80fb5961b91dd4724e69ff7610a2fa3cb",
      "scripts/ci/clued-production-publisher-source.mjs": "0e3c2d4df3fb2f4ceb6ec8750028e2b046a1a0b6",
      "scripts/ci/clued-publisher-qualification-source.mjs": "f38859449e35eeeef492db8130f91c266c208d75",
      "config/merge-admission-policy.json": "a54ea27028f6361765fffce30f9ffa227a91b2ea",
      "apps/clued-cloud/app/supabase-public-config.ts": "65fa503f686a5ae3571bcca743067b19fab41482",
      "scripts/ci/clued-production-publisher-sources.json": "df10a840de4d00961d9df55103e6c6849fba23fb",
      "scripts/ci/clued-publisher-qualification-sources.json": "34bbd3c400af8565ed28545af2ba839c5f920d40",
      "scripts/ci/clued-gated-proof-profiles.json": "6220bee3be9f83dfeea524959dc9ae4530557309",
      "scripts/ci/clued-gated-proof-role-specs.json": "834393be58f6356800b7515b1c64e6f34720fb68",
      "scripts/ci/clued-gated-proof-runtime.mjs": "4f709a21394876dd9a1806d948458de1e6e2d84c",
      "scripts/ci/clued-gated-proof.mjs": "859b26a0f203459c67f1567ccfb91009fba37133",
      "scripts/ci/clued-docs-only.py": "395f086b58ea3ff6cb5946660da734cc5072938f",
      "scripts/ci/test_clued_docs_only.py": "509cf8c428349a13d979584e3493435445defa27",
      "scripts/ci/clued-main-control-integration.test.mjs": "31035c7d36a89f02af7b23999c7e9dd50ae295cb",
      "scripts/ci/fixtures/control-secret-workflow-source-history.v1.json": "d1ee7ce1f49e4fa39f52dc8b05b61ca7e24147f7",
      "scripts/ci/clued-release-grant.mjs": "4070fa2718d76d3e180dc9327324ffa410721e3b",
      "scripts/ci/merge-admission-policy.fixtures.mjs": "ed612e7f6bcff6f7e9f843f57b8e8f33ef074f95",
      "scripts/ci/clued-trusted-automation-route.test.mjs": "28ad79546e810876220f3c8139624367868e7664",
      "scripts/ci/clued-work-admission.test.mjs": "48a2b8d7195e4233a7c17b30649381e4e9b925d2",
      "scripts/ci/automation-route-source-history.fixture.mjs": "66bb2dfd1722b298109c1f221a8b10e4e034e390",
      "scripts/ci/fixtures/automation-route-source-history.v1.json": "a82c68e6524a120adefd4f74c5183320349c2730",
      "scripts/ci/clued-bootstrap-ordinary-source.test.mjs": "226cd6a96906cdca748db8d9079e2edfaa837aa9",
      "scripts/ci/merge-admission-policy.test.mjs": "3fbce1e3245bc5cf1d931b8ccac782ff65229d79",
      "scripts/ci/clued-release-grant.test.mjs": "77a2ac1ffa082338b673621aaf01b26aaefaf865",
      "scripts/runner/clued-runner-job-started.test.mjs": "697b035de19394f4e9fad22bb4ebcba1624ff53e",
      "scripts/runner/clued-runner-job-started.work-handover-current-epoch-proxy-dispatch-v1.mjs": "f1355a6592f8cdfe1a007d461c57296f0525dbbf"
    },
    "predecessor_implementation_blobs": {
      ".github/actions/ci-temporary-storage/action.yml": "72a78ada2553dc42a062dbccf310d1b23e65431f",
      ".github/actions/ci-temporary-storage/setup.mjs": "dd162105b2800d31b9970d25575945a140a69d42",
      ".github/actions/ci-temporary-storage/setup.py": "4e3f82e061162f894e310f6e767bacf8c57a079b",
      "apps/clued-cloud/app/supabase-public-config.ts": "65fa503f686a5ae3571bcca743067b19fab41482",
      "config/merge-admission-policy.json": "a54ea27028f6361765fffce30f9ffa227a91b2ea",
      "scripts/ci/clued-gated-proof-profiles.json": "5c988ff706f7a33f1259f890c7e81d98ecbb7bd5",
      "scripts/ci/clued-gated-proof-role-specs.json": "4003147031897bbefdea44f491ae2edfd9ecfdca",
      "scripts/ci/clued-production-publisher-source.mjs": "0e3c2d4df3fb2f4ceb6ec8750028e2b046a1a0b6",
      "scripts/ci/clued-production-publisher-sources.json": "df10a840de4d00961d9df55103e6c6849fba23fb",
      "scripts/ci/clued-publisher-qualification-source.mjs": "f38859449e35eeeef492db8130f91c266c208d75",
      "scripts/ci/clued-publisher-qualification-sources.json": "34bbd3c400af8565ed28545af2ba839c5f920d40",
      "scripts/ci/clued-release-grant.mjs": "4070fa2718d76d3e180dc9327324ffa410721e3b",
      "scripts/ci/clued-release-grant.test.mjs": "77a2ac1ffa082338b673621aaf01b26aaefaf865",
      "scripts/ci/clued-work-admission.mjs": "b413917364fccdda1d10ec1fee799f82b313a29f",
      "scripts/ci/clued-work-admission.test.mjs": "d3c9dab76a00ad4e09b9bef64b0e44d2d9bec7ef",
      "scripts/ci/clued-workflow-profile.mjs": "c7b1f0f80fb5961b91dd4724e69ff7610a2fa3cb",
      "scripts/ci/merge-admission-measurement-history.mjs": "6799c148ee7baf51a5ba989de73fb8bffb054f6f",
      "scripts/ci/merge-admission-policy.fixtures.mjs": "ed612e7f6bcff6f7e9f843f57b8e8f33ef074f95",
      "scripts/ci/merge-admission-policy.mjs": "a3f6830e0087474d3e36222d12975deb7830c4d3",
      "scripts/ci/merge-admission-policy.test.mjs": "3fbce1e3245bc5cf1d931b8ccac782ff65229d79",
      "scripts/ci/merge-admission-source-producer.mjs": "2f428d400de4dbf0a9feca2bd27269c0dd353033",
      "scripts/runner/clued-runner-job-started.mjs": "f1355a6592f8cdfe1a007d461c57296f0525dbbf",
      "scripts/runner/clued-runner-job-started.test.mjs": "697b035de19394f4e9fad22bb4ebcba1624ff53e",
      "scripts/runner/clued-runner-job-started.work-handover-current-epoch-proxy-dispatch-v1.mjs": "f1355a6592f8cdfe1a007d461c57296f0525dbbf"
    },
    "predecessor_absent_current_dependencies": [
      "scripts/ci/clued-main-control-integration.test.mjs",
      "scripts/ci/fixtures/control-secret-workflow-source-history.v1.json",
      "scripts/ci/clued-trusted-automation-route.test.mjs",
      "scripts/ci/automation-route-source-history.fixture.mjs",
      "scripts/ci/fixtures/automation-route-source-history.v1.json",
      "scripts/ci/clued-bootstrap-ordinary-source.test.mjs"
    ]
  },
  ".github/workflows/clued-work-admission-reverify.yml": {
    "family": "trusted_main_secret_controller",
    "migrating_jobs": [
      "reverify"
    ],
    "predecessor_blob": "8d112ceea21487b9ef871558a2e3bab8decef126",
    "predecessor_sha256": "81974b780acd57fd727ca85b6c5067f835de4a5e2c73e81bcfb9745c10e22cbf",
    "predecessor_definition_sha256": "2824389cc2c9edf04954958593becbbe6c90cf9c97511580cd7ccfb3656ecf3f",
    "implementation_blobs": {
      ".github/actions/ci-temporary-storage/action.yml": "72a78ada2553dc42a062dbccf310d1b23e65431f",
      ".github/actions/ci-temporary-storage/setup.mjs": "dd162105b2800d31b9970d25575945a140a69d42",
      ".github/actions/ci-temporary-storage/setup.py": "4e3f82e061162f894e310f6e767bacf8c57a079b",
      "scripts/ci/clued-work-admission.mjs": "0e53b628735cb5cbd90ef2f61ab999e46350f385",
      "scripts/ci/merge-admission-policy.mjs": "a3f6830e0087474d3e36222d12975deb7830c4d3",
      "scripts/ci/merge-admission-measurement-history.mjs": "6799c148ee7baf51a5ba989de73fb8bffb054f6f",
      "scripts/ci/merge-admission-source-producer.mjs": "2f428d400de4dbf0a9feca2bd27269c0dd353033",
      "scripts/runner/clued-runner-job-started.mjs": "f1355a6592f8cdfe1a007d461c57296f0525dbbf",
      "scripts/ci/clued-workflow-profile.mjs": "c7b1f0f80fb5961b91dd4724e69ff7610a2fa3cb",
      "scripts/ci/clued-production-publisher-source.mjs": "0e3c2d4df3fb2f4ceb6ec8750028e2b046a1a0b6",
      "scripts/ci/clued-publisher-qualification-source.mjs": "f38859449e35eeeef492db8130f91c266c208d75",
      "config/merge-admission-policy.json": "a54ea27028f6361765fffce30f9ffa227a91b2ea",
      "apps/clued-cloud/app/supabase-public-config.ts": "65fa503f686a5ae3571bcca743067b19fab41482",
      "scripts/ci/clued-production-publisher-sources.json": "df10a840de4d00961d9df55103e6c6849fba23fb",
      "scripts/ci/clued-publisher-qualification-sources.json": "34bbd3c400af8565ed28545af2ba839c5f920d40",
      "scripts/ci/clued-gated-proof-profiles.json": "6220bee3be9f83dfeea524959dc9ae4530557309",
      "scripts/ci/clued-gated-proof-role-specs.json": "834393be58f6356800b7515b1c64e6f34720fb68",
      "scripts/ci/clued-merge-slot-ci.mjs": "f043aa3badd6e861bce69ac38134399e04a21115",
      "scripts/ci/clued-gated-proof.mjs": "859b26a0f203459c67f1567ccfb91009fba37133",
      "scripts/ci/clued-gated-proof-runtime.mjs": "4f709a21394876dd9a1806d948458de1e6e2d84c",
      "scripts/ci/clued-managed-auto-merge.mjs": "738e887104de888abc9bd63f2d86a135a891ffb8",
      "scripts/ci/clued-docs-only.py": "395f086b58ea3ff6cb5946660da734cc5072938f",
      "scripts/ci/test_clued_docs_only.py": "509cf8c428349a13d979584e3493435445defa27"
    },
    "predecessor_implementation_blobs": {
      ".github/actions/ci-temporary-storage/action.yml": "72a78ada2553dc42a062dbccf310d1b23e65431f",
      ".github/actions/ci-temporary-storage/setup.mjs": "dd162105b2800d31b9970d25575945a140a69d42",
      ".github/actions/ci-temporary-storage/setup.py": "4e3f82e061162f894e310f6e767bacf8c57a079b",
      "apps/clued-cloud/app/supabase-public-config.ts": "65fa503f686a5ae3571bcca743067b19fab41482",
      "config/merge-admission-policy.json": "a54ea27028f6361765fffce30f9ffa227a91b2ea",
      "scripts/ci/clued-docs-only.py": "395f086b58ea3ff6cb5946660da734cc5072938f",
      "scripts/ci/clued-gated-proof-profiles.json": "5c988ff706f7a33f1259f890c7e81d98ecbb7bd5",
      "scripts/ci/clued-gated-proof-role-specs.json": "4003147031897bbefdea44f491ae2edfd9ecfdca",
      "scripts/ci/clued-gated-proof-runtime.mjs": "1015f7afb9eb1c089027918640a934e0f32b9289",
      "scripts/ci/clued-gated-proof.mjs": "859b26a0f203459c67f1567ccfb91009fba37133",
      "scripts/ci/clued-managed-auto-merge.mjs": "738e887104de888abc9bd63f2d86a135a891ffb8",
      "scripts/ci/clued-merge-slot-ci.mjs": "f043aa3badd6e861bce69ac38134399e04a21115",
      "scripts/ci/clued-production-publisher-source.mjs": "0e3c2d4df3fb2f4ceb6ec8750028e2b046a1a0b6",
      "scripts/ci/clued-production-publisher-sources.json": "df10a840de4d00961d9df55103e6c6849fba23fb",
      "scripts/ci/clued-publisher-qualification-source.mjs": "f38859449e35eeeef492db8130f91c266c208d75",
      "scripts/ci/clued-publisher-qualification-sources.json": "34bbd3c400af8565ed28545af2ba839c5f920d40",
      "scripts/ci/clued-work-admission.mjs": "b413917364fccdda1d10ec1fee799f82b313a29f",
      "scripts/ci/clued-workflow-profile.mjs": "c7b1f0f80fb5961b91dd4724e69ff7610a2fa3cb",
      "scripts/ci/merge-admission-measurement-history.mjs": "6799c148ee7baf51a5ba989de73fb8bffb054f6f",
      "scripts/ci/merge-admission-policy.mjs": "a3f6830e0087474d3e36222d12975deb7830c4d3",
      "scripts/ci/merge-admission-source-producer.mjs": "2f428d400de4dbf0a9feca2bd27269c0dd353033",
      "scripts/ci/test_clued_docs_only.py": "509cf8c428349a13d979584e3493435445defa27",
      "scripts/runner/clued-runner-job-started.mjs": "f1355a6592f8cdfe1a007d461c57296f0525dbbf"
    },
    "predecessor_absent_current_dependencies": []
  },
  ".github/workflows/clued-work-admission-dispatch.yml": {
    "family": "trusted_main_secret_controller",
    "migrating_jobs": [
      "admit"
    ],
    "predecessor_blob": "797efcd6218b04b347e0cd55d3352ac70cca2167",
    "predecessor_sha256": "7532852c8c798e00299288eac34483510110b0872dd9091dd97dad905ae15b4a",
    "predecessor_definition_sha256": "6463f2c033fbec8d4fcfbd7129e052cfcac99500707a30cab615f9c522c69608",
    "implementation_blobs": {
      ".github/actions/ci-temporary-storage/action.yml": "72a78ada2553dc42a062dbccf310d1b23e65431f",
      ".github/actions/ci-temporary-storage/setup.mjs": "dd162105b2800d31b9970d25575945a140a69d42",
      ".github/actions/ci-temporary-storage/setup.py": "4e3f82e061162f894e310f6e767bacf8c57a079b",
      "scripts/ci/clued-work-admission.mjs": "0e53b628735cb5cbd90ef2f61ab999e46350f385",
      "scripts/ci/merge-admission-policy.mjs": "a3f6830e0087474d3e36222d12975deb7830c4d3",
      "scripts/ci/merge-admission-measurement-history.mjs": "6799c148ee7baf51a5ba989de73fb8bffb054f6f",
      "scripts/ci/merge-admission-source-producer.mjs": "2f428d400de4dbf0a9feca2bd27269c0dd353033",
      "scripts/runner/clued-runner-job-started.mjs": "f1355a6592f8cdfe1a007d461c57296f0525dbbf",
      "scripts/ci/clued-workflow-profile.mjs": "c7b1f0f80fb5961b91dd4724e69ff7610a2fa3cb",
      "scripts/ci/clued-production-publisher-source.mjs": "0e3c2d4df3fb2f4ceb6ec8750028e2b046a1a0b6",
      "scripts/ci/clued-publisher-qualification-source.mjs": "f38859449e35eeeef492db8130f91c266c208d75",
      "config/merge-admission-policy.json": "a54ea27028f6361765fffce30f9ffa227a91b2ea",
      "apps/clued-cloud/app/supabase-public-config.ts": "65fa503f686a5ae3571bcca743067b19fab41482",
      "scripts/ci/clued-production-publisher-sources.json": "df10a840de4d00961d9df55103e6c6849fba23fb",
      "scripts/ci/clued-publisher-qualification-sources.json": "34bbd3c400af8565ed28545af2ba839c5f920d40",
      "scripts/ci/clued-gated-proof-profiles.json": "6220bee3be9f83dfeea524959dc9ae4530557309",
      "scripts/ci/clued-gated-proof-role-specs.json": "834393be58f6356800b7515b1c64e6f34720fb68"
    },
    "predecessor_implementation_blobs": {
      ".github/actions/ci-temporary-storage/action.yml": "72a78ada2553dc42a062dbccf310d1b23e65431f",
      ".github/actions/ci-temporary-storage/setup.mjs": "dd162105b2800d31b9970d25575945a140a69d42",
      ".github/actions/ci-temporary-storage/setup.py": "4e3f82e061162f894e310f6e767bacf8c57a079b",
      "apps/clued-cloud/app/supabase-public-config.ts": "65fa503f686a5ae3571bcca743067b19fab41482",
      "config/merge-admission-policy.json": "a54ea27028f6361765fffce30f9ffa227a91b2ea",
      "scripts/ci/clued-gated-proof-profiles.json": "5c988ff706f7a33f1259f890c7e81d98ecbb7bd5",
      "scripts/ci/clued-gated-proof-role-specs.json": "4003147031897bbefdea44f491ae2edfd9ecfdca",
      "scripts/ci/clued-production-publisher-source.mjs": "0e3c2d4df3fb2f4ceb6ec8750028e2b046a1a0b6",
      "scripts/ci/clued-production-publisher-sources.json": "df10a840de4d00961d9df55103e6c6849fba23fb",
      "scripts/ci/clued-publisher-qualification-source.mjs": "f38859449e35eeeef492db8130f91c266c208d75",
      "scripts/ci/clued-publisher-qualification-sources.json": "34bbd3c400af8565ed28545af2ba839c5f920d40",
      "scripts/ci/clued-work-admission.mjs": "b413917364fccdda1d10ec1fee799f82b313a29f",
      "scripts/ci/clued-workflow-profile.mjs": "c7b1f0f80fb5961b91dd4724e69ff7610a2fa3cb",
      "scripts/ci/merge-admission-measurement-history.mjs": "6799c148ee7baf51a5ba989de73fb8bffb054f6f",
      "scripts/ci/merge-admission-policy.mjs": "a3f6830e0087474d3e36222d12975deb7830c4d3",
      "scripts/ci/merge-admission-source-producer.mjs": "2f428d400de4dbf0a9feca2bd27269c0dd353033",
      "scripts/runner/clued-runner-job-started.mjs": "f1355a6592f8cdfe1a007d461c57296f0525dbbf"
    },
    "predecessor_absent_current_dependencies": []
  },
  ".github/workflows/clued-merge-slot-ci.yml": {
    "family": "trusted_main_secret_controller",
    "migrating_jobs": [
      "report"
    ],
    "predecessor_blob": "662dbc3e846311379efa5f081b3cca518a881f74",
    "predecessor_sha256": "e70d2af52990a31edbd0dda551a37b2c7a288e042d6eb0dcf1dc4b07dffd1d23",
    "predecessor_definition_sha256": "3acc6919502f79a5c30b04751b991431801a35b0d80480db208fd0bbeaed8e6b",
    "implementation_blobs": {
      ".github/actions/ci-temporary-storage/action.yml": "72a78ada2553dc42a062dbccf310d1b23e65431f",
      ".github/actions/ci-temporary-storage/setup.mjs": "dd162105b2800d31b9970d25575945a140a69d42",
      ".github/actions/ci-temporary-storage/setup.py": "4e3f82e061162f894e310f6e767bacf8c57a079b",
      "scripts/ci/clued-work-admission.mjs": "0e53b628735cb5cbd90ef2f61ab999e46350f385",
      "scripts/ci/merge-admission-policy.mjs": "a3f6830e0087474d3e36222d12975deb7830c4d3",
      "scripts/ci/merge-admission-measurement-history.mjs": "6799c148ee7baf51a5ba989de73fb8bffb054f6f",
      "scripts/ci/merge-admission-source-producer.mjs": "2f428d400de4dbf0a9feca2bd27269c0dd353033",
      "scripts/runner/clued-runner-job-started.mjs": "f1355a6592f8cdfe1a007d461c57296f0525dbbf",
      "scripts/ci/clued-workflow-profile.mjs": "c7b1f0f80fb5961b91dd4724e69ff7610a2fa3cb",
      "scripts/ci/clued-production-publisher-source.mjs": "0e3c2d4df3fb2f4ceb6ec8750028e2b046a1a0b6",
      "scripts/ci/clued-publisher-qualification-source.mjs": "f38859449e35eeeef492db8130f91c266c208d75",
      "config/merge-admission-policy.json": "a54ea27028f6361765fffce30f9ffa227a91b2ea",
      "apps/clued-cloud/app/supabase-public-config.ts": "65fa503f686a5ae3571bcca743067b19fab41482",
      "scripts/ci/clued-production-publisher-sources.json": "df10a840de4d00961d9df55103e6c6849fba23fb",
      "scripts/ci/clued-publisher-qualification-sources.json": "34bbd3c400af8565ed28545af2ba839c5f920d40",
      "scripts/ci/clued-gated-proof-profiles.json": "6220bee3be9f83dfeea524959dc9ae4530557309",
      "scripts/ci/clued-gated-proof-role-specs.json": "834393be58f6356800b7515b1c64e6f34720fb68",
      "scripts/ci/clued-merge-slot-ci.mjs": "f043aa3badd6e861bce69ac38134399e04a21115",
      "scripts/ci/clued-gated-proof.mjs": "859b26a0f203459c67f1567ccfb91009fba37133",
      "scripts/ci/clued-gated-proof-runtime.mjs": "4f709a21394876dd9a1806d948458de1e6e2d84c",
      "scripts/ci/clued-managed-auto-merge.mjs": "738e887104de888abc9bd63f2d86a135a891ffb8",
      "scripts/ci/clued-docs-only.py": "395f086b58ea3ff6cb5946660da734cc5072938f",
      "scripts/ci/test_clued_docs_only.py": "509cf8c428349a13d979584e3493435445defa27",
      "scripts/ci/clued-merge-executor.mjs": "ca3b23fa07d733c2163e33375424961de6190ff4",
      "scripts/ci/clued-merge-slot-ci.test.mjs": "ff1a7fca21c56e387a41f8b5cc6d122673e03d24",
      "scripts/ci/clued-merge-executor.test.mjs": "7ce28e317b9a75e2156add6de04efd2c74243571"
    },
    "predecessor_implementation_blobs": {
      ".github/actions/ci-temporary-storage/action.yml": "72a78ada2553dc42a062dbccf310d1b23e65431f",
      ".github/actions/ci-temporary-storage/setup.mjs": "dd162105b2800d31b9970d25575945a140a69d42",
      ".github/actions/ci-temporary-storage/setup.py": "4e3f82e061162f894e310f6e767bacf8c57a079b",
      "apps/clued-cloud/app/supabase-public-config.ts": "65fa503f686a5ae3571bcca743067b19fab41482",
      "config/merge-admission-policy.json": "a54ea27028f6361765fffce30f9ffa227a91b2ea",
      "scripts/ci/clued-docs-only.py": "395f086b58ea3ff6cb5946660da734cc5072938f",
      "scripts/ci/clued-gated-proof-profiles.json": "5c988ff706f7a33f1259f890c7e81d98ecbb7bd5",
      "scripts/ci/clued-gated-proof-role-specs.json": "4003147031897bbefdea44f491ae2edfd9ecfdca",
      "scripts/ci/clued-gated-proof-runtime.mjs": "1015f7afb9eb1c089027918640a934e0f32b9289",
      "scripts/ci/clued-gated-proof.mjs": "859b26a0f203459c67f1567ccfb91009fba37133",
      "scripts/ci/clued-managed-auto-merge.mjs": "738e887104de888abc9bd63f2d86a135a891ffb8",
      "scripts/ci/clued-merge-executor.mjs": "ca3b23fa07d733c2163e33375424961de6190ff4",
      "scripts/ci/clued-merge-executor.test.mjs": "286e7cdfcb677bdb21088d896f39d9438d6505c5",
      "scripts/ci/clued-merge-slot-ci.mjs": "f043aa3badd6e861bce69ac38134399e04a21115",
      "scripts/ci/clued-merge-slot-ci.test.mjs": "ea72a36aaa82dcac64a47e3ea586538ea26aa602",
      "scripts/ci/clued-production-publisher-source.mjs": "0e3c2d4df3fb2f4ceb6ec8750028e2b046a1a0b6",
      "scripts/ci/clued-production-publisher-sources.json": "df10a840de4d00961d9df55103e6c6849fba23fb",
      "scripts/ci/clued-publisher-qualification-source.mjs": "f38859449e35eeeef492db8130f91c266c208d75",
      "scripts/ci/clued-publisher-qualification-sources.json": "34bbd3c400af8565ed28545af2ba839c5f920d40",
      "scripts/ci/clued-work-admission.mjs": "b413917364fccdda1d10ec1fee799f82b313a29f",
      "scripts/ci/clued-workflow-profile.mjs": "c7b1f0f80fb5961b91dd4724e69ff7610a2fa3cb",
      "scripts/ci/merge-admission-measurement-history.mjs": "6799c148ee7baf51a5ba989de73fb8bffb054f6f",
      "scripts/ci/merge-admission-policy.mjs": "a3f6830e0087474d3e36222d12975deb7830c4d3",
      "scripts/ci/merge-admission-source-producer.mjs": "2f428d400de4dbf0a9feca2bd27269c0dd353033",
      "scripts/ci/test_clued_docs_only.py": "509cf8c428349a13d979584e3493435445defa27",
      "scripts/runner/clued-runner-job-started.mjs": "f1355a6592f8cdfe1a007d461c57296f0525dbbf"
    },
    "predecessor_absent_current_dependencies": []
  },
  ".github/workflows/clued-merge-executor.yml": {
    "family": "trusted_main_secret_controller",
    "migrating_jobs": [
      "execute"
    ],
    "predecessor_blob": "727d4fdce1c8be1565b8f09c715422f9c7a35c88",
    "predecessor_sha256": "585a0c85a28b8e4f35e2e58e7339e72411ed0dda2f468e161021d17b6f1e5a5d",
    "predecessor_definition_sha256": "7fc67cc1f440d35ff22d568756e99db39018982d2302bb89aeddce28fd46568f",
    "implementation_blobs": {
      ".github/actions/ci-temporary-storage/action.yml": "72a78ada2553dc42a062dbccf310d1b23e65431f",
      ".github/actions/ci-temporary-storage/setup.mjs": "dd162105b2800d31b9970d25575945a140a69d42",
      ".github/actions/ci-temporary-storage/setup.py": "4e3f82e061162f894e310f6e767bacf8c57a079b",
      "scripts/ci/clued-work-admission.mjs": "0e53b628735cb5cbd90ef2f61ab999e46350f385",
      "scripts/ci/merge-admission-policy.mjs": "a3f6830e0087474d3e36222d12975deb7830c4d3",
      "scripts/ci/merge-admission-measurement-history.mjs": "6799c148ee7baf51a5ba989de73fb8bffb054f6f",
      "scripts/ci/merge-admission-source-producer.mjs": "2f428d400de4dbf0a9feca2bd27269c0dd353033",
      "scripts/runner/clued-runner-job-started.mjs": "f1355a6592f8cdfe1a007d461c57296f0525dbbf",
      "scripts/ci/clued-workflow-profile.mjs": "c7b1f0f80fb5961b91dd4724e69ff7610a2fa3cb",
      "scripts/ci/clued-production-publisher-source.mjs": "0e3c2d4df3fb2f4ceb6ec8750028e2b046a1a0b6",
      "scripts/ci/clued-publisher-qualification-source.mjs": "f38859449e35eeeef492db8130f91c266c208d75",
      "config/merge-admission-policy.json": "a54ea27028f6361765fffce30f9ffa227a91b2ea",
      "apps/clued-cloud/app/supabase-public-config.ts": "65fa503f686a5ae3571bcca743067b19fab41482",
      "scripts/ci/clued-production-publisher-sources.json": "df10a840de4d00961d9df55103e6c6849fba23fb",
      "scripts/ci/clued-publisher-qualification-sources.json": "34bbd3c400af8565ed28545af2ba839c5f920d40",
      "scripts/ci/clued-gated-proof-profiles.json": "6220bee3be9f83dfeea524959dc9ae4530557309",
      "scripts/ci/clued-gated-proof-role-specs.json": "834393be58f6356800b7515b1c64e6f34720fb68",
      "scripts/ci/clued-merge-slot-ci.mjs": "f043aa3badd6e861bce69ac38134399e04a21115",
      "scripts/ci/clued-gated-proof.mjs": "859b26a0f203459c67f1567ccfb91009fba37133",
      "scripts/ci/clued-gated-proof-runtime.mjs": "4f709a21394876dd9a1806d948458de1e6e2d84c",
      "scripts/ci/clued-managed-auto-merge.mjs": "738e887104de888abc9bd63f2d86a135a891ffb8",
      "scripts/ci/clued-docs-only.py": "395f086b58ea3ff6cb5946660da734cc5072938f",
      "scripts/ci/test_clued_docs_only.py": "509cf8c428349a13d979584e3493435445defa27",
      "scripts/ci/clued-merge-executor.mjs": "ca3b23fa07d733c2163e33375424961de6190ff4",
      "scripts/ci/clued-merge-slot-ci.test.mjs": "ff1a7fca21c56e387a41f8b5cc6d122673e03d24",
      "scripts/ci/clued-merge-executor.test.mjs": "7ce28e317b9a75e2156add6de04efd2c74243571"
    },
    "predecessor_implementation_blobs": {
      ".github/actions/ci-temporary-storage/action.yml": "72a78ada2553dc42a062dbccf310d1b23e65431f",
      ".github/actions/ci-temporary-storage/setup.mjs": "dd162105b2800d31b9970d25575945a140a69d42",
      ".github/actions/ci-temporary-storage/setup.py": "4e3f82e061162f894e310f6e767bacf8c57a079b",
      "apps/clued-cloud/app/supabase-public-config.ts": "65fa503f686a5ae3571bcca743067b19fab41482",
      "config/merge-admission-policy.json": "a54ea27028f6361765fffce30f9ffa227a91b2ea",
      "scripts/ci/clued-docs-only.py": "395f086b58ea3ff6cb5946660da734cc5072938f",
      "scripts/ci/clued-gated-proof-profiles.json": "5c988ff706f7a33f1259f890c7e81d98ecbb7bd5",
      "scripts/ci/clued-gated-proof-role-specs.json": "4003147031897bbefdea44f491ae2edfd9ecfdca",
      "scripts/ci/clued-gated-proof-runtime.mjs": "1015f7afb9eb1c089027918640a934e0f32b9289",
      "scripts/ci/clued-gated-proof.mjs": "859b26a0f203459c67f1567ccfb91009fba37133",
      "scripts/ci/clued-managed-auto-merge.mjs": "738e887104de888abc9bd63f2d86a135a891ffb8",
      "scripts/ci/clued-merge-executor.mjs": "ca3b23fa07d733c2163e33375424961de6190ff4",
      "scripts/ci/clued-merge-executor.test.mjs": "286e7cdfcb677bdb21088d896f39d9438d6505c5",
      "scripts/ci/clued-merge-slot-ci.mjs": "f043aa3badd6e861bce69ac38134399e04a21115",
      "scripts/ci/clued-merge-slot-ci.test.mjs": "ea72a36aaa82dcac64a47e3ea586538ea26aa602",
      "scripts/ci/clued-production-publisher-source.mjs": "0e3c2d4df3fb2f4ceb6ec8750028e2b046a1a0b6",
      "scripts/ci/clued-production-publisher-sources.json": "df10a840de4d00961d9df55103e6c6849fba23fb",
      "scripts/ci/clued-publisher-qualification-source.mjs": "f38859449e35eeeef492db8130f91c266c208d75",
      "scripts/ci/clued-publisher-qualification-sources.json": "34bbd3c400af8565ed28545af2ba839c5f920d40",
      "scripts/ci/clued-work-admission.mjs": "b413917364fccdda1d10ec1fee799f82b313a29f",
      "scripts/ci/clued-workflow-profile.mjs": "c7b1f0f80fb5961b91dd4724e69ff7610a2fa3cb",
      "scripts/ci/merge-admission-measurement-history.mjs": "6799c148ee7baf51a5ba989de73fb8bffb054f6f",
      "scripts/ci/merge-admission-policy.mjs": "a3f6830e0087474d3e36222d12975deb7830c4d3",
      "scripts/ci/merge-admission-source-producer.mjs": "2f428d400de4dbf0a9feca2bd27269c0dd353033",
      "scripts/ci/test_clued_docs_only.py": "509cf8c428349a13d979584e3493435445defa27",
      "scripts/runner/clued-runner-job-started.mjs": "f1355a6592f8cdfe1a007d461c57296f0525dbbf"
    },
    "predecessor_absent_current_dependencies": []
  }
});
// This initial Source has no predecessor. Its exact bytes and complete Role
// are registered on trusted main in phase A; adding the workflow is a later
// phase and still needs ordinary Owner, Source and Host qualification gates.
export const MERGE_RECONCILE_CONTROL_SOURCE=freeze({
  "file": ".github/workflows/clued-merge-reconcile.yml",
  "workflow_blob": "499c88f35012124bdcec316d9f0b17737867550a",
  "source_sha256": "11d4b72a9f330801bdb44d3bd8a5b6c411cd328b02a6946ab9ada7485ec7dbf3",
  "workflow_definition_sha256": "bc320b63b09ede8a615d1efa7298771543f350fa74974a475624f814dcaffd18",
  "role_digests": {
    "reconcile": "66f0ab7a81fb3e6c6465d19434dde50474f30907a34593f3f0a2ed45121a2a9f"
  },
  "implementation_blobs": {
    ".github/actions/ci-temporary-storage/action.yml": "72a78ada2553dc42a062dbccf310d1b23e65431f",
    ".github/actions/ci-temporary-storage/check-workflows.mjs": "bd30bbb8527d86a9e3c2bd2aafe07e0eb1a342fc",
    ".github/actions/ci-temporary-storage/coverage.json": "12f0ff5aca09df465aa0461d493485c3ed2c65b1",
    ".github/actions/ci-temporary-storage/setup.mjs": "dd162105b2800d31b9970d25575945a140a69d42",
    ".github/actions/ci-temporary-storage/setup.py": "4e3f82e061162f894e310f6e767bacf8c57a079b",
    ".github/workflows/active-doc-links.yml": "25d1f1913f3831df099f9bd5f2c26167a6e03457",
    ".github/workflows/clued-capture-guard.yml": "93569fe998837d45c455b2915fe60afb1ce20f92",
    ".github/workflows/clued-ci-health.yml": "92beab08d57f01c083915be121681b20b47540d4",
    ".github/workflows/clued-ci-runner-heartbeat.yml": "707debbca71be56b749301b29467bc5d117fe7ef",
    ".github/workflows/clued-ci-usage-report.yml": "6a8dc97f08bdbf2dd4f258a0628acdb89401277e",
    ".github/workflows/clued-cloud-node22-install.yml": "30e783feb7ab54a578b5ed3b692fa664e00207d1",
    ".github/workflows/clued-cloud-production-release.yml": "a0080f76d3e9a9ef5bc6b5e381e7e825d45d7917",
    ".github/workflows/clued-cloud-quality-gate.yml": "a811a0128db82fb23f78b51fefea73288a103223",
    ".github/workflows/clued-components.yml": "c1d5649e420263e313ff5d52247b09d27920536f",
    ".github/workflows/clued-compute-panel.yml": "7d263683953b140897c30681828924d6a183b26c",
    ".github/workflows/clued-connection-authorization.yml": "3d20ba406c8397cfa86bf29be6904bf9fb6ba287",
    ".github/workflows/clued-currentness-post-deploy-attestation.yml": "89cf50e55da80b05a966140447a7f09697918555",
    ".github/workflows/clued-g4-database.yml": "a09cfc44e506a9672e5221a7fa6737747ddcb787",
    ".github/workflows/clued-handover-disposable-idle.yml": "97c39730ce75f2ea2427c9fa3845f9df32e998f8",
    ".github/workflows/clued-handover-external-qualification.yml": "689a1c5fcdbefa5353715f55e39c0fc08a9f5230",
    ".github/workflows/clued-information-flow-prod-e2e.yml": "f4072579babbd0d2470d2d4d2d4fad2a663b0a19",
    ".github/workflows/clued-integration-runtime-config.yml": "b935a6d72eaf8c7979426527db53719151b6d89a",
    ".github/workflows/clued-integration-runtime-nightly.yml": "89ebfe7c7e436a9a74210d546a1e759a989ff5bc",
    ".github/workflows/clued-merge-executor.yml": "727d4fdce1c8be1565b8f09c715422f9c7a35c88",
    ".github/workflows/clued-merge-slot-ci.yml": "b2178adc5af19d0eaea359616388edf7fb7d3446",
    ".github/workflows/clued-native617-admission-dispatch.yml": "b3bac281913f30e0a30ad2adba28e1c9e822e5a5",
    ".github/workflows/clued-release-tags.yml": "161c5acf28d6cb2f3413bf0180e18945b03831c1",
    ".github/workflows/clued-required-tests.yml": "8a22de3a97425d9f85bc9f605dbdbf748b8e0946",
    ".github/workflows/clued-standard-runner-actor-qualification.yml": "d752e91ae501313396163df277883d2d02fa100e",
    ".github/workflows/clued-storage-executor-window.yml": "7fd8110117406ffe7ba56d856898ce2671ec2019",
    ".github/workflows/clued-storage-read-config.yml": "65e01f4871fbbb1d7f00f2350c272555f8898b75",
    ".github/workflows/clued-work-admission-dispatch.yml": "6f9410a9b33d8055fcc5044c4f87c2612b4aca93",
    ".github/workflows/clued-work-admission-reverify.yml": "8d112ceea21487b9ef871558a2e3bab8decef126",
    ".github/workflows/clued-work-admission.yml": "19e67fd3b6b706b3c957506a7bfce6d8aeb7fd3b",
    ".github/workflows/clued-work-claim-handover-revoke.yml": "0b1ef5cb73bede5cc16c4a92d7589e640d14e7bd",
    ".github/workflows/clued-work-handover-qualification-company-linux-01.yml": "f1e02e5ebbfe582daf43e7b22a527914a4ab1218",
    ".github/workflows/clued-work-handover-qualification-company-linux-02.yml": "c4aee6b6a1dd789072906dd39ffba2d6a99a3988",
    ".github/workflows/clued-work-handover-qualification-company-linux-03.yml": "411f13aab6f5b1688ed4878a9a0802176e6b52de",
    ".github/workflows/clued-work-handover-qualification-company-linux-04.yml": "30f95c881e816cdbbe27aec150d30eae616744cc",
    ".github/workflows/clued-work-handover-qualification-company-win-01.yml": "6e9cf8df20614d82d878ad95c3787659ed3cfb4b",
    ".github/workflows/clued-work-handover-qualification-home-win-01.yml": "0a6d9ec09e4d6a7e02aba6c40a96b3502a7b894c",
    ".github/workflows/contract-placement.yml": "3640f0895cc72caffb8b2bc0c1df21b76b4b5340",
    ".github/workflows/design-refs.yml": "8ff267e0a83f068280a8e0317597a40c1fd95bce",
    ".github/workflows/gitleaks.yml": "6441fc32b084002de697415ea8343af07816c929",
    ".github/workflows/information-flow-e2e.yml": "312e1ef4d963ccf5be13ee9db57b30cdaef6cf99",
    ".github/workflows/memory-publication-gate.yml": "02988b3be31122457485e1ba6189a71e70de8d54",
    ".github/workflows/model-program-m0.yml": "2256bbe59ae43358d4539cd67a8ae41ccbd7e793",
    ".github/workflows/model-program-m1-entry.yml": "e8fd6b3a2cc3b370c2ec1fa399d44a3484e1041e",
    ".github/workflows/model-program-m1-harness.yml": "71c62b755ea8909b16efbc71c2a231a330b57b41",
    ".github/workflows/model-program-m1-package.yml": "ec9db2bf92db1830cb826329b6e771c26292d7ac",
    ".github/workflows/model-program-m2-scoped-consumer.yml": "fbae19b9afee314358c82a781d889e2041c7798e",
    ".github/workflows/mps03-native-agent.yml": "7c1408e4382731d204b2d08a2feedb7593db7944",
    ".github/workflows/multitrack-governance-projection.yml": "f3fe9bd271b988b754c4273b991beb3b9d136f58",
    ".github/workflows/node-profile-policy.yml": "b69ec865c471b13970fb39c78935f99c9f007e28",
    ".github/workflows/phase2-naming-surface-inventory.yml": "082ba6d5418cfcf7e0e35b1f1c4a2d314d21d4a7",
    ".github/workflows/phase2-v027-validation.yml": "66b1f55b67f9a7315a627cf2400e04a9f92de9ed",
    ".github/workflows/public-mcp-behavior.yml": "05aaf31c642cee6be608b4aa1f635f6f1f9df5ec",
    ".github/workflows/public-mcp-gate-receipt.yml": "3a6afbeeee101dd1d1cfb9c9ed24e8d9c661f2d9",
    ".github/workflows/public-mcp-protocol.yml": "cdd4a4a1e55c3e59b933b8617fdd9c44310f2078",
    ".github/workflows/runner-budget-policy.yml": "9a5f46cdb30f2fb0394f0ea3c0fdb91a7539cb13",
    ".github/workflows/trivy.yml": "9867c4c847a61aa33761e27b793e0928bc6cbfdc",
    "apps/clued-cloud/app/supabase-public-config.ts": "193fedd8e9d5ccaea873e2cc4d0efd894e93d6ae",
    "apps/clued-cloud/package-lock.json": "c95270a01c228d6dfa66e42c95e2ac113e547039",
    "apps/clued-cloud/package.json": "491e528ddcc1aaf1a77e1a870da14a63269d5a61",
    "config/clued-mechanical-files.json": "ca52cf896a0c6fda896ef2341f79d9fa86c5da13",
    "config/merge-admission-policy.json": "a54ea27028f6361765fffce30f9ffa227a91b2ea",
    "scripts/ci/activity-conflict-caller.test.mjs": "308ea425b4d50d8ee265a89ef19125664ee22755",
    "scripts/ci/admission-self-test-lists.test.mjs": "b9d811bd56d092bb306626a982a70e8ffddf4661",
    "scripts/ci/check_active_doc_links.py": "b3caf5820ed68dc6cfef94f549bb0a56313c41e7",
    "scripts/ci/check_contract_placement.py": "b861c8e101dbc244ffb7854398638db9caf9d5cc",
    "scripts/ci/check_design_refs.py": "a2ce870214a478cab93d421b5518743b17b1aa94",
    "scripts/ci/ci-known-failures.json": "5160b90b20a89bda347857122844a0470b35f400",
    "scripts/ci/ci-required-selection.mjs": "12fbf6e1a14b5e9a9b986ed0dbbb6c5a99271e5a",
    "scripts/ci/ci-required-selection.test.mjs": "dc3fd6dc10dd7c57b0119726c1385bebbbf5cafe",
    "scripts/ci/ci-test-failures-reporter.mjs": "7d28bbcad6f69b975ce3f43adcb493f2f78c29ae",
    "scripts/ci/ci-usage-attribution.mjs": "33d052936a08c3fbe571fecccf6d58f8868f22fd",
    "scripts/ci/ci-usage-attribution.test.mjs": "a5cec64ac8792942e0389826e57126b277437d7d",
    "scripts/ci/ci-usage-report.mjs": "d1ac298c1e6a9b77640457904ff316e8eae601df",
    "scripts/ci/ci-usage-report.test.mjs": "a011c193c6911d2dd332f47d755309f9f8bc5748",
    "scripts/ci/clued-control-workflow-source.test.mjs": "6c09840711c7bf9fc9fd122b7b6cf15db49bbce2",
    "scripts/ci/clued-docs-only.py": "395f086b58ea3ff6cb5946660da734cc5072938f",
    "scripts/ci/clued-g4-fresh-start.mjs": "f8a53eb4fecd241be6f5a20146a5b7d34b51724b",
    "scripts/ci/clued-g4-fresh-start.test.mjs": "b59a2f6560b473b12ffec323bd14f9729455f1d7",
    "scripts/ci/clued-gated-proof-profiles.json": "05650ffd3d4f5c9d8c1cde6aab1668838eaddbd4",
    "scripts/ci/clued-gated-proof-role-specs.json": "28a2750730f1d9c9d22759d67acdf7c35985cb5b",
    "scripts/ci/clued-gated-proof-runtime.mjs": "c7884078fee3afbf98681425982051a87df38ce9",
    "scripts/ci/clued-gated-proof-runtime.test.mjs": "8a2d3b70efc89792ce48c88a137c5ae0772cd96a",
    "scripts/ci/clued-gated-proof.mjs": "d92a4cbec0992e16a7c69ded5540be1f40c2d39a",
    "scripts/ci/clued-gated-proof.test.mjs": "0bc2b6e8a0009dd049a3c58b1f6b8ddbc8b11227",
    "scripts/ci/clued-handover-external-bootstrap.mjs": "482ceab6e8cd2a8941608855d7f495d17917187d",
    "scripts/ci/clued-handover-external-catalog-identities.mjs": "f9a834815979691282573a19fd1d10e9eee6ea41",
    "scripts/ci/clued-handover-external-catalog-identities.test.mjs": "107c4d844969f120870c28c064f182559582b17b",
    "scripts/ci/clued-handover-external-catalog.mjs": "1b3db76686d72add0a757d5e2507ce59cc08b7c3",
    "scripts/ci/clued-handover-external-driver.late-idle-source3-v1.mjs": "2a6779ba7c605f091af9c0689647c81270e009bd",
    "scripts/ci/clued-handover-external-driver.mjs": "1fa7b0111447d94c2e079648c57b3b6d83de63c2",
    "scripts/ci/clued-handover-external-fixture-locator.mjs": "57814315d92ff8f75ee44522766288610cb6f51b",
    "scripts/ci/clued-handover-external-fixture-locator.test.mjs": "920015cfe57efc8fefa9d279ab91eeda9381cf94",
    "scripts/ci/clued-handover-external-gate-evidence.fixture.mjs": "a8e0f671e14a67a10be12750462c6bc279633f7e",
    "scripts/ci/clued-handover-external-gate-evidence.mjs": "9c1ef6160f5d8ed4610388a10033d90af553671e",
    "scripts/ci/clued-handover-external-gate-evidence.test.mjs": "99264155f9f80e97cf1aa27c6308934926a6ef06",
    "scripts/ci/clued-handover-external-journal.late-idle-source3-v1.mjs": "bfbdab6d02d11c9b0031a8f852f68580503082f2",
    "scripts/ci/clued-handover-external-journal.mjs": "0d0cdbec05f01cd549abdaa0eaa9128ae6b28c22",
    "scripts/ci/clued-handover-external-pg-transport.mjs": "d595c63e0871bd786307c95981cbb825a858c38a",
    "scripts/ci/clued-handover-external-pg-transport.test.mjs": "90cabbe36c96a38927ea28ba2a4f3c51cb1af398",
    "scripts/ci/clued-handover-external-provider.integration.test.mjs": "fce6985cf65d955f24ba828bb94ed04c60fb15ce",
    "scripts/ci/clued-handover-external-provider.mjs": "9111994ce338e0fb938d35be7f8a93508e41c0b9",
    "scripts/ci/clued-handover-external-register.late-idle-source3-v1.mjs": "208bb4e7c224b1373564688e399286b4985ece9d",
    "scripts/ci/clued-handover-external-register.mjs": "1ecde4fd9904bb0e726a02c516d5cb7901f74d66",
    "scripts/ci/clued-handover-external-source-check.late-idle-source3-v1.mjs": "aa8bca822f08ee1015e017abb74106d7cfaf0ccb",
    "scripts/ci/clued-handover-external-source-check.mjs": "43198c863961aff63dadb8860d4b61516cc0106f",
    "scripts/ci/clued-handover-external-source-check.test.mjs": "d60fda9a9feb95ed03bbb703abc8cbf134360192",
    "scripts/ci/clued-handover-external-source-pins.json": "b3278f1558074c804f09ca7b07946b32a6770c2e",
    "scripts/ci/clued-handover-native-entry.mjs": "d6682bdece007f142bd53185d70427c7eb3e7f7c",
    "scripts/ci/clued-handover-native-entry.test.mjs": "6a906024380357eb0c4776f9d3496a1472430a25",
    "scripts/ci/clued-independent-legacy-drain.mjs": "010ae787af58164e3438a317cbcc80ab88524dcc",
    "scripts/ci/clued-independent-legacy-drain.test.mjs": "7bd6642aff58eb96ceff622da5f1feaba36c274a",
    "scripts/ci/clued-independent-publication-identity.mjs": "1abf7547bf9a2edf22eb748bb0eeea17410ddf77",
    "scripts/ci/clued-independent-publication-identity.test.mjs": "4f4c10cf2bb978e569bccd71ec5613fe787ba55a",
    "scripts/ci/clued-independent-publication-port.mjs": "edcbad82115aa42cc3508cf338ae82aca8d4f445",
    "scripts/ci/clued-independent-publication-port.test.mjs": "4491ae0f7a2d0d6c589cc87c9010490b00b09882",
    "scripts/ci/clued-independent-publication-runtime.mjs": "afe70fbd4f10f446bb51b16b39102e5f9ae42676",
    "scripts/ci/clued-independent-publication-runtime.test.mjs": "f3218b078c77926d7db5c34cae4e2bdda6ce7c94",
    "scripts/ci/clued-independent-revocation-controller.mjs": "43a338d7d418266dfa4e34dfd8bf7b7c97a91212",
    "scripts/ci/clued-independent-revocation-controller.test.mjs": "138b379775d236a34d4ed34e5da2d20f11b89395",
    "scripts/ci/clued-independent-revoker.mjs": "cff38423ded0aef08d7a36570f06b285e2cd1eb0",
    "scripts/ci/clued-independent-revoker.test.mjs": "92c1f6a1e018d42ad3fb147569cf85059cad97e3",
    "scripts/ci/clued-independent-supervisor.mjs": "78621c34380097a87479cce3f519343e629d7e9c",
    "scripts/ci/clued-independent-supervisor.test.mjs": "509d040b58e3992a7a18fef8b4d8f2d0adfff523",
    "scripts/ci/clued-managed-auto-merge.mjs": "738e887104de888abc9bd63f2d86a135a891ffb8",
    "scripts/ci/clued-merge-executor.mjs": "ad24cfc6ff54bdd3f27960ff49c82e95c09da8aa",
    "scripts/ci/clued-merge-executor.test.mjs": "33e38adb2cd83463976cfd500ba32a34014a6f36",
    "scripts/ci/clued-merge-reconcile-activation.json": "e61960eee71153b579ef619c8881ad9a369a8395",
    "scripts/ci/clued-merge-reconcile-gate.mjs": "9eeb75422fb8fd1a153255b8791b6612c25525c8",
    "scripts/ci/clued-merge-reconcile-gate.test.mjs": "e7c61128605334cc8bccd511832c63452c8e1f01",
    "scripts/ci/clued-merge-reconcile-host.mjs": "a54822ad781da3544bf4b31543698321231bb20a",
    "scripts/ci/clued-merge-reconcile-source-build.mjs": "860478495500a7f22e29b0ac6d31b6285352330e",
    "scripts/ci/clued-merge-reconcile-source.mjs": "c3660096b818e8b432ac641f84526c7a4e0d0664",
    "scripts/ci/clued-merge-reconcile-source.test.mjs": "68801654aa3adab6cb971a0f56c9fdc8b7159bc5",
    "scripts/ci/clued-merge-reconcile.mjs": "6296ce6bef57a53085b112d6d1d185e369f6f2ac",
    "scripts/ci/clued-merge-reconcile.test.mjs": "4ba6676ccb86455b8a65a870830aed9189c266c9",
    "scripts/ci/clued-merge-slot-ci.mjs": "b26a73bc6e05c4917d236a15e62b5ff01955f7b0",
    "scripts/ci/clued-merge-slot-ci.test.mjs": "204c517784a71c0230c1c116a09fc938ea0f2361",
    "scripts/ci/clued-merge-train-native.mjs": "cc282db3a9d518880926faa85a260332890f6a39",
    "scripts/ci/clued-merge-train-native.test.mjs": "06314db02e915da5d35334ff188c1ecd774c1b98",
    "scripts/ci/clued-non-pr-control-source.mjs": "2a79ff33de2e92a57e580c70471d89282f7fe60b",
    "scripts/ci/clued-non-pr-control-source.test.mjs": "aafdc6ad1e2c66ff0fb05a53af0b97ea5dbdcd89",
    "scripts/ci/clued-non-pr-control-sources.json": "7afedd2a42894bdab11df22e73925572bdcbdd8e",
    "scripts/ci/clued-production-publisher-source.mjs": "0e3c2d4df3fb2f4ceb6ec8750028e2b046a1a0b6",
    "scripts/ci/clued-production-publisher-source.test.mjs": "357e4dcc2395d192a7dc4950e8867bdfbfa85678",
    "scripts/ci/clued-production-publisher-sources.json": "df10a840de4d00961d9df55103e6c6849fba23fb",
    "scripts/ci/clued-publisher-qualification-source.mjs": "f38859449e35eeeef492db8130f91c266c208d75",
    "scripts/ci/clued-publisher-qualification-source.test.mjs": "287c05394a30aeeac1df819465f35ff4d1639522",
    "scripts/ci/clued-publisher-qualification-sources.json": "34bbd3c400af8565ed28545af2ba839c5f920d40",
    "scripts/ci/clued-push-reuse.mjs": "1b52fed4874e9a1068ead26e32603a40f09e7d95",
    "scripts/ci/clued-push-reuse.test.mjs": "6112e0a785c08cf2d6fd55543cd5d86b99f153aa",
    "scripts/ci/clued-reader-budget-cache.test.mjs": "716a00549bb394d67b93d2b117d25aefe5aeb43b",
    "scripts/ci/clued-registry-scan-guard.mjs": "c84e590a13ef796854ae8b27e95b9c2e92c34384",
    "scripts/ci/clued-release-grant.mjs": "4070fa2718d76d3e180dc9327324ffa410721e3b",
    "scripts/ci/clued-release-grant.test.mjs": "77a2ac1ffa082338b673621aaf01b26aaefaf865",
    "scripts/ci/clued-required-applicability.mjs": "19d8ac176b4708f2976bbaaae816ad2f4a43b1d4",
    "scripts/ci/clued-required-applicability.test.mjs": "81947c73519c250979f15f88aab4282343fef3cb",
    "scripts/ci/clued-scan-start-732-successor.test.mjs": "9615c689042aa2cebcf2f8817f7a8e3bbe5877ec",
    "scripts/ci/clued-scan-start-prereg.test.mjs": "83b3b9bb200f46bd97385e444cb2fc781656f871",
    "scripts/ci/clued-scan-start.mjs": "07042a02682d818f7e51a8d4e6105d7cc58c4b27",
    "scripts/ci/clued-scan-start.test.mjs": "8fcfe1d6b92f865a216e1154a3044b8feb595f07",
    "scripts/ci/clued-source-only-workflow.mjs": "ab784bff64ac4caaad473ffe728e391997df6594",
    "scripts/ci/clued-source-only-workflow.test.mjs": "51a222b76c384af2f2ae2646054f30352200a0f2",
    "scripts/ci/clued-standard-runner-actor-source.mjs": "e8de9a37f939941fc5ce05627c08e2db57a298e6",
    "scripts/ci/clued-standard-runner-actor-source.test.mjs": "399d7c66d3a51e88f6c2e1eda5cb95bfbbf0d5b1",
    "scripts/ci/clued-standard-runner-actor-sources.json": "5112f5f0102fd7f9828fe96b0b07930f77dd0e6e",
    "scripts/ci/clued-work-admission.mjs": "8243529af88c7bfb64b0a139846f33eb08eefa34",
    "scripts/ci/clued-work-admission.test.mjs": "4dc4b4156b11f4ade89b30b9e524c8d6f0e3ffd6",
    "scripts/ci/clued-work-claim-handover.mjs": "faf43f077c97dc2d9b4a88d77d2080d5d77feb97",
    "scripts/ci/clued-work-claim-handover.test.mjs": "e9aa945f3c9bed7b8045896403ea1167ada27d93",
    "scripts/ci/clued-workflow-profile-codec.test.mjs": "8e1e5d9b4d21c888d7895d52c9dec801f2fab5c2",
    "scripts/ci/clued-workflow-profile.mjs": "69622ceef577da9e4eb8dab25fed4bdc1cbb50f3",
    "scripts/ci/clued-workflow-profile.test.mjs": "cc1bbf38b2624d8984095f652de8e648342bebab",
    "scripts/ci/clued_release_tags.py": "ddcf627022ad24c7f742deafff7ce1c082cfaed7",
    "scripts/ci/component-version-integration-policy.mjs": "f64fadb108c552dbd2dec19d191720fbb236da06",
    "scripts/ci/fixtures/heartbeat-pr890-strategy-shrink.v1.json": "698a552135a03ef043c7dbe756792bb6d44b9f47",
    "scripts/ci/fixtures/hosted-migration-source-history.v1.json": "410880ed1bb93317c0d9d960bbfee60206abdfac",
    "scripts/ci/fixtures/production-publisher-source-history.v1.json": "cd275888d584917f29a8faf4b20aa95f4f67c5c7",
    "scripts/ci/fixtures/workflow-profiles-69e30b6/fixture.mjs": "2f1cebb5db5d6695b32838ce60d68a4adb895749",
    "scripts/ci/fixtures/workflow-profiles-69e30b6/profile-member-order.json": "cf0681cfedca4f4ef8a2fc726c1c3adf89573d9b",
    "scripts/ci/fixtures/workflow-profiles-69e30b6/profiles.disk3.json": "a366ca6096d4edde87aeb0a8ff7f7da382ee01ff",
    "scripts/ci/fixtures/workflow-profiles-69e30b6/role-specs.json": "4003147031897bbefdea44f491ae2edfd9ecfdca",
    "scripts/ci/hosted-migration-source-history.fixture.mjs": "04921032fa5732f846b5733eaf0585aa4538114d",
    "scripts/ci/local-verify-concurrency.test.mjs": "2d6ce14e9707d14a53cde1edbcc37c5b711d1f41",
    "scripts/ci/local-verify.mjs": "c477baa7372cd4fc6d094e3e77ea0d814399c3dd",
    "scripts/ci/local-verify.test.mjs": "6943ea9fdd4e0e1ad31cf59f37ce193ffff5c9bc",
    "scripts/ci/main-entry-legacy.json": "9d46a60b80f0a14583c92db218279ef20f82b6d2",
    "scripts/ci/main-entry-realpath.test.mjs": "713628337928b90d47e3407669f8c2b8a57b2b75",
    "scripts/ci/merge-admission-clock-bootstrap.mjs": "aea8e5478ecfddc6fd600df0e2234cb5dec18651",
    "scripts/ci/merge-admission-clock-bootstrap.test.mjs": "4947199daf2cbac2b9be3a99135101bfdfeb3125",
    "scripts/ci/merge-admission-clock-source.mjs": "cd41ff8fda30c3c008571b2e8dfce94e8062eca4",
    "scripts/ci/merge-admission-clock-source.test.mjs": "3e29d8529461013eb29b54a86dc10c4d49df45b6",
    "scripts/ci/merge-admission-four-sources.mjs": "6cd400053095b2b688082cf56e0ea1d7b4afd97a",
    "scripts/ci/merge-admission-four-sources.test.mjs": "88636637e3a5ba1638548836f9205b23fc88f1f5",
    "scripts/ci/merge-admission-measurement-history.mjs": "6799c148ee7baf51a5ba989de73fb8bffb054f6f",
    "scripts/ci/merge-admission-measurement-history.test.mjs": "69706c856e83c2b791d67fd5dcbefcb35430b6b9",
    "scripts/ci/merge-admission-native-activity.mjs": "46a3db44b79236b26dc8a50b263761d599552c63",
    "scripts/ci/merge-admission-native-population.mjs": "879bb7688b206a5c5592aba0b8e61865c9ec6bc5",
    "scripts/ci/merge-admission-natural-frame.mjs": "5fe132a94b5dc7aa8afb3f31eeb019a84cbb3283",
    "scripts/ci/merge-admission-natural-frame.test.mjs": "3fa835eedee053316d92d410f20d49dc1f8b8e8f",
    "scripts/ci/merge-admission-natural-intake.mjs": "42270d9965aa643be7cb3f4d8fc2f3108bf23dcf",
    "scripts/ci/merge-admission-policy-file.test.mjs": "1846292d9b93c88919f39eaa1eaa59817e91a227",
    "scripts/ci/merge-admission-policy.fixtures.mjs": "ed612e7f6bcff6f7e9f843f57b8e8f33ef074f95",
    "scripts/ci/merge-admission-policy.mjs": "a3f6830e0087474d3e36222d12975deb7830c4d3",
    "scripts/ci/merge-admission-policy.test.mjs": "3fbce1e3245bc5cf1d931b8ccac782ff65229d79",
    "scripts/ci/merge-admission-r9-collector.mjs": "5e7938964e640b063718da885e2ca906351f8720",
    "scripts/ci/merge-admission-r9-collector.test.mjs": "8b9d502437a870096b8f87a573dd9e6ffa39ecb2",
    "scripts/ci/merge-admission-r9-reregister.mjs": "bba4ae50c7103146cfdf3294d726d9fd67a18169",
    "scripts/ci/merge-admission-r9-reregister.test.mjs": "1349b5664206d391f8d55bb1773e8938d0b0eb50",
    "scripts/ci/merge-admission-r9-runtime-inputs.mjs": "481127caabb425e854d24ba3d7919528ad604c8d",
    "scripts/ci/merge-admission-r9-source.json": "853481a8d14c1f45a7b4d918ea3d10eb8e7df747",
    "scripts/ci/merge-admission-source-producer.mjs": "2f428d400de4dbf0a9feca2bd27269c0dd353033",
    "scripts/ci/merge-admission-source-producer.test.mjs": "6a244bb8ec7492eb3803fbeae8f5fe061c896ee1",
    "scripts/ci/nonpush-seal-caller.test.mjs": "e1de4fc66cc44f09854a7ed48958267a4c3c8e01",
    "scripts/ci/npm-cache-observation.mjs": "8c4078cca852c2eccf1383f5568235ae3d3c5a43",
    "scripts/ci/npm-cache-observation.test.mjs": "9d41c9278c541dc1421f3e0817854c106fc50a15",
    "scripts/ci/pr-repush-preflight.mjs": "f72548494c256137da07deab61b4c5dab2684ddb",
    "scripts/ci/pr-repush-preflight.test.mjs": "6b219ff097279faa336e5c88f56267c23ae49695",
    "scripts/ci/production-publisher-source-history.fixture.mjs": "4aa8ff63465816a55bbce709613fc84d37d145d1",
    "scripts/ci/public-mcp-hosted-space.mjs": "a8ed0db21e35177af09eae22f6b3b1bf21081a3b",
    "scripts/ci/public-mcp-hosted-space.test.mjs": "9ba33859d993b5db75ead83251190f6466644f93",
    "scripts/ci/public-mcp-supabase-isolation.mjs": "df889edf4e8ab0e0078d88dddff2e1948f720834",
    "scripts/ci/public-mcp-supabase-isolation.test.mjs": "bfedec007fbfab9118823fa7abd6097499265e08",
    "scripts/ci/reviewed_gitleaks.py": "9ba49feff74b4f24f0c76db9a87f7cd1cf15c96d",
    "scripts/ci/reviewed_gitleaks_historical.py": "1940f3260ffb39b8d74e3fe90d05fc8079051c50",
    "scripts/ci/self-hosted/apply-wsl-capacity-profile.ps1": "9c9dd2d64d5d59c8576053110aaf17420c295d56",
    "scripts/ci/self-hosted/bootstrap-linux-runner.sh": "45bb49c3843249099f0f09a1c1b558f4af1eac61",
    "scripts/ci/self-hosted/bootstrap-windows-runner.ps1": "58eac8a42757122f6ce5901902f15146d54fbdc0",
    "scripts/ci/self-hosted/ci_health.py": "ea096610d12b7adb400145879bbf4fbbf206c46a",
    "scripts/ci/self-hosted/ci_health_analyze.py": "6fd11f1e8e83ecdf33a745fb51f361bcb9b7be1f",
    "scripts/ci/self-hosted/ci_health_transport.py": "8bc1d8e63bb7e77fa2fa25ac2f28c131ad1c6f89",
    "scripts/ci/self-hosted/compute_panel.py": "463039a77cdc2eda9eaec2af09c3ceb80597ccb1",
    "scripts/ci/self-hosted/host-port-lock.sh": "cfb0c3e5d399c3699d27d4fbbebe96e13628d99b",
    "scripts/ci/self-hosted/node-profiles.json": "1b12191f34b87ed4b47e14f29e0e0b5860871f55",
    "scripts/ci/self-hosted/render-host-watchdog.ps1": "d8f13bce44ee5173b4f58152bfcf18370ee82fc5",
    "scripts/ci/self-hosted/resource-maintenance/enroll.py": "890fd0471108c82541eab6940f23b2e4538c76c0",
    "scripts/ci/self-hosted/resource-maintenance/maintenance.py": "567d5afba8cdebc9d2a10b608d798cbec365eb73",
    "scripts/ci/self-hosted/resource-maintenance/probe.py": "2558077b5730715aca500f64a677ac29ed460983",
    "scripts/ci/self-hosted/resource-maintenance/producer.py": "db98c1ffcd27fa574899e4a5d87655f92d5b1e71",
    "scripts/ci/self-hosted/resource-maintenance/schedule.py": "01ff4ab36ad1365b72d4f13e58c1991f950b677a",
    "scripts/ci/self-hosted/resource-maintenance/security.py": "aa103fc3ecd923caeed28cbfefa3c7b219ebc89a",
    "scripts/ci/self-hosted/resource-maintenance/test_maintenance.py": "bc927075aae9067b19dce279e49257b029f37e0d",
    "scripts/ci/self-hosted/resource-maintenance/test_producer.py": "4cb0cb0ef5c0d65aeebbc5fc008157d208955dbf",
    "scripts/ci/self-hosted/resource-maintenance/test_schedule_probe.py": "f22a4932513bd258eb62167d3d4eb9d35e871fef",
    "scripts/ci/self-hosted/validate_node_profiles.py": "d6b0c3d96e2f9959877d3e833b3f5725e1b633ec",
    "scripts/ci/self-hosted/watchdog-capacity-alert.test.mjs": "443469aa843a77fbc3c5afa6d125d0d337d4b27d",
    "scripts/ci/setup-clued-dev-linux.ps1": "5d1413748d20ab4c77b14b2c10e1cc39ba2b83c1",
    "scripts/ci/setup-clued-dev-linux.test.mjs": "eda0cb5c2aea48a21063973ce015dc10486f1aae",
    "scripts/ci/test_check_contract_placement.py": "c2632533201bf4c626d2acd595ce88e3efc9c18d",
    "scripts/ci/test_check_design_refs.py": "9213683b1020bdb9b0a4b17a1d1ccd2984edfb0a",
    "scripts/ci/test_clued_docs_only.py": "509cf8c428349a13d979584e3493435445defa27",
    "scripts/ci/test_clued_release_tags.py": "b448500a8165f8d45ee88638357993589583c955",
    "scripts/ci/test_validate_runner_budget_policy.py": "45c574468e1e5346ae8cc07807008ba343b77090",
    "scripts/ci/validate_runner_budget_policy.py": "ca0a99364149c99f0bfd9e53f80d022e3ed5ad36",
    "scripts/runner/clued-runner-job-started.mjs": "263c9f53b42c66c385fdb808345170ead9462ccf",
    "scripts/runner/clued-runner-job-started.ps1": "fef4e73df2d80afe79bb7efebd8b8cd27e4cdf95",
    "scripts/runner/clued-runner-job-started.sh": "8bed3c563fe901551f512aeb274c79e2e222ce43",
    "scripts/runner/clued-runner-job-started.test.mjs": "1097a52ab76241d365c3c0af49e34412dc9cc807",
    "scripts/runner/clued-runner-job-started.work-handover-current-epoch-proxy-dispatch-v1.mjs": "f1355a6592f8cdfe1a007d461c57296f0525dbbf",
    "scripts/runner/clued-runner-job-started.work-handover-native-admission-retry-v1.mjs": "263c9f53b42c66c385fdb808345170ead9462ccf",
    "scripts/runner/clued-runner-job-started.work-handover-native-admission-v1.mjs": "dd6dcaf875539c23a9e87726542de8179a81456a",
    "scripts/runner/qualify-native-admission-candidate.mjs": "dd0f6fac19a66773cfb13fc760d08c690448f82a",
    "scripts/runner/qualify-native-admission-retry-candidate.mjs": "d1f53e338800f5c3b8f679ab67605aacb0df343b",
    "scripts/runner/qualify-standard-runner-actor.mjs": "794861b9acf7659ef2bb946f2c1dff7ef33fbd10",
    "scripts/runner/qualify-work-handover.mjs": "56fe8c96ee1fb295f6ac66c7a08279e6bfe17ceb",
    "scripts/runner/qualify-work-handover.test.mjs": "3ee0639db53111a48ed90eae9112dc45c53fabd5",
    "scripts/runner/standard-runner-actor181/actor-execution-files221.json": "266fcc9fd723ce2834101f49ad8c9f90646305d1",
    "scripts/runner/standard-runner-actor181/actor-execution-pins221.json": "0397a1b0b8994e58047e3d68f050c86aa14c97d1",
    "scripts/runner/standard-runner-actor181/actor-execution-subject221.json": "db17cf0ac0bb1a91bff748b069f6ad2efcbde07c",
    "scripts/runner/standard-runner-actor181/bridge/console_frame181.mjs": "1724525792e1eb1c3c008dcc9b7d62b9e8f51971",
    "scripts/runner/standard-runner-actor181/capture/actor.ps1": "2290c59783fb56e7d2e44033dc43e5e4476c830c",
    "scripts/runner/standard-runner-actor181/capture/definition.ps1": "e4b97f833e294c83ceee80a8a45be7ad14480553",
    "scripts/runner/standard-runner-actor181/capture/observer_core.ps1": "145fb38f0a514f8fadf1f9fa097ec097bfbd7488",
    "scripts/runner/standard-runner-actor181/capture/observer_entry.ps1": "cb98e2378155e41da338df1d1bbf11e9b2627cdc",
    "scripts/runner/standard-runner-actor181/capture/observer_os.ps1": "8182b135bd2c891ef9ae122d997e7bcfb86f5906",
    "scripts/runner/standard-runner-actor181/capture/registration.ps1": "a0bd5f4903026ab22640f7f3dad368c9ffa65d53",
    "scripts/runner/standard-runner-actor181/capture/runner_entry.ps1": "158bd6052ff4d6293e9144a56e2caedd66faf5f5",
    "scripts/runner/standard-runner-actor181/errors.mjs": "ce590f76e902cb1052809330c2fb5946c9c768c9",
    "scripts/runner/standard-runner-actor181/host-install/actor.ps1": "54fc663749a31356c026d3904be7d982f2b8a0f1",
    "scripts/runner/standard-runner-actor181/host-install/budget-table216.json": "6748df658ea7d4b7903733453bf9162c2d029f82",
    "scripts/runner/standard-runner-actor181/host-install/build_capture216.mjs": "4cc15c4abb2a915ff4e490defe461f2d5ee46e0c",
    "scripts/runner/standard-runner-actor181/host-install/capture-inputs216.json": "600cd22b22f7eb86f0202cde010564a5c6506c27",
    "scripts/runner/standard-runner-actor181/host-install/capture_pins216.mjs": "2995b27cc1a96c74d88c6076691f5465be653b58",
    "scripts/runner/standard-runner-actor181/host-install/code-epochs216.json": "38737a5bc3af7cbc471b4f4bc3db516810c5c8dc",
    "scripts/runner/standard-runner-actor181/host-install/console_frame.mjs": "1724525792e1eb1c3c008dcc9b7d62b9e8f51971",
    "scripts/runner/standard-runner-actor181/host-install/console_transport.mjs": "56b4ea61f2dee24ad682049a8c4f35af8727c59f",
    "scripts/runner/standard-runner-actor181/host-install/definition.ps1": "e4b97f833e294c83ceee80a8a45be7ad14480553",
    "scripts/runner/standard-runner-actor181/host-install/enrollment_adapter.ps1": "a7db800d386273b553c2e301daeabe5582fa3941",
    "scripts/runner/standard-runner-actor181/host-install/enrollment_code.py": "308018ae2b5b6b3f68312231fe40b5ad38bacc31",
    "scripts/runner/standard-runner-actor181/host-install/imports216.json": "32563178a7ce8943749ebcc3cd4b743f26435dc4",
    "scripts/runner/standard-runner-actor181/host-install/install_observer216.ps1": "5f2a0c36d49be49d4883232608f8b5a194e7b478",
    "scripts/runner/standard-runner-actor181/host-install/install_observer_entry216.ps1": "b68a0903ea41c611e711ebc26a91bb005d736a82",
    "scripts/runner/standard-runner-actor181/host-install/install_relay216.ps1": "11950ac1b703340663562c7982d7ed45a06908e6",
    "scripts/runner/standard-runner-actor181/host-install/install_relay_entry216.ps1": "f25e79aa7745c60777d49332e7acfdfaf653ed8c",
    "scripts/runner/standard-runner-actor181/host-install/namespace.ps1": "c06ccffa1291cf2e96baac203e65aa9faa4b11ae",
    "scripts/runner/standard-runner-actor181/host-install/native-provenance216.json": "7dfad9346f74ccc12c146864f4c889893689abb6",
    "scripts/runner/standard-runner-actor181/host-install/node_ingress.ps1": "e83ffedb4532cecb18ed97740eb42f2c6cced0bc",
    "scripts/runner/standard-runner-actor181/host-install/observer-capture216.json": "7db99dfcf59f22dbd585381628df472d735bc179",
    "scripts/runner/standard-runner-actor181/host-install/observer.ps1": "240714addf44482d2c864c38e332e7ec834095dd",
    "scripts/runner/standard-runner-actor181/host-install/parent_bootstrap.ps1": "f4468e612fc0714ca9dee6b8838b968f4a072a13",
    "scripts/runner/standard-runner-actor181/host-install/qual_helpers.ps1": "ec9e0fd250c888db9ab7d733c5ae67f2922f4057",
    "scripts/runner/standard-runner-actor181/host-install/qual_receiver.ps1": "1fd7233243a13ddc90911e032948aa0b0de859c8",
    "scripts/runner/standard-runner-actor181/host-install/registration.ps1": "a0bd5f4903026ab22640f7f3dad368c9ffa65d53",
    "scripts/runner/standard-runner-actor181/host-install/root_entry.ps1": "22ee34febebbc124df3c577f015e102c6769e867",
    "scripts/runner/standard-runner-actor181/host-install/self-bootstrap215.json": "708919ead2c35b058aca40ebca691c9790039cc6",
    "scripts/runner/standard-runner-actor181/host-install/self_helpers.ps1": "2290c59783fb56e7d2e44033dc43e5e4476c830c",
    "scripts/runner/standard-runner-actor181/host-install/uac_supervisor.ps1": "f68dab4610504f5120c261e55c50f01eabcf7095",
    "scripts/runner/standard-runner-actor181/host-install/xml.ps1": "e5edafc9be5ac12fde9e17eb2a98ba8652391d53",
    "scripts/runner/standard-runner-actor181/host-qualification/authority_server_with_reader181.ps1": "eb1bd930bb899a14e34f14eaec9aa470017ad5eb",
    "scripts/runner/standard-runner-actor181/host-qualification/ba_observer_wrapper181.ps1": "7bc17f8ed503ea930146682576a9bbd1373b5369",
    "scripts/runner/standard-runner-actor181/host-qualification/build_capture214.mjs": "c369cf0e49eb0c20b72d940d768d08c8bec8b87b",
    "scripts/runner/standard-runner-actor181/host-qualification/capture-inputs214.json": "6b6111cbaa2bd2f7a6ea9cb2f69dac7f8d58ff9c",
    "scripts/runner/standard-runner-actor181/host-qualification/capture_pins214.mjs": "1a6523ce0af05582bd4121eea17d5977ac87f791",
    "scripts/runner/standard-runner-actor181/host-qualification/console_frame181.mjs": "1724525792e1eb1c3c008dcc9b7d62b9e8f51971",
    "scripts/runner/standard-runner-actor181/host-qualification/console_transport214.mjs": "56b4ea61f2dee24ad682049a8c4f35af8727c59f",
    "scripts/runner/standard-runner-actor181/host-qualification/observer_entry181.ps1": "cb98e2378155e41da338df1d1bbf11e9b2627cdc",
    "scripts/runner/standard-runner-actor181/host-qualification/owned_effects214.ps1": "58f3f6df565c819df41cd4b0a68caf350ea2aef4",
    "scripts/runner/standard-runner-actor181/host-qualification/parent_bootstrap181.ps1": "f4468e612fc0714ca9dee6b8838b968f4a072a13",
    "scripts/runner/standard-runner-actor181/host-qualification/relay_entry214.ps1": "ecdde4f95cbcd620240835ba24fa07d11405d617",
    "scripts/runner/standard-runner-actor181/host-qualification/relay_ingress_mux216.ps1": "f2522f374f3fc176a186e1644288c7b569446a6c",
    "scripts/runner/standard-runner-actor181/host-qualification/root_node_ingress212.ps1": "e83ffedb4532cecb18ed97740eb42f2c6cced0bc",
    "scripts/runner/standard-runner-actor181/host-qualification/root_uac_supervisor181.ps1": "f68dab4610504f5120c261e55c50f01eabcf7095",
    "scripts/runner/standard-runner-actor181/host-qualification/selector_publisher216.ps1": "1f4f9c8784a8840751420afd4bbf2e27bcca1fc8",
    "scripts/runner/standard-runner-actor181/host-qualification/self_registration_actor181.ps1": "2290c59783fb56e7d2e44033dc43e5e4476c830c",
    "scripts/runner/standard-runner-actor181/host-qualification/self_registration_observer181.ps1": "145fb38f0a514f8fadf1f9fa097ec097bfbd7488",
    "scripts/runner/standard-runner-actor181/host-qualification/self_registration_observer_os181.ps1": "8182b135bd2c891ef9ae122d997e7bcfb86f5906",
    "scripts/runner/standard-runner-actor181/host-qualification/supervisor_entry214.ps1": "22ee34febebbc124df3c577f015e102c6769e867",
    "scripts/runner/standard-runner-actor181/host-qualification/windows_task_definition181.ps1": "e4b97f833e294c83ceee80a8a45be7ad14480553",
    "scripts/runner/standard-runner-actor181/host-qualification/windows_task_registration_account181.ps1": "a0bd5f4903026ab22640f7f3dad368c9ffa65d53",
    "scripts/runner/standard-runner-actor181/installed-authority.mjs": "d87c6aa7477c5101e3b1cbffe18b7d60f8719738",
    "scripts/runner/standard-runner-actor181/installed-provider.mjs": "a5e4c2ad51c6bfadc7def5ecf8c78368597f1aa1",
    "scripts/runner/standard-runner-actor181/joint-capture.mjs": "beef27b4c6afd077204a70b5ce206652344a09ba",
    "scripts/runner/standard-runner-actor181/joint/authority_server_with_reader181.ps1": "eb1bd930bb899a14e34f14eaec9aa470017ad5eb",
    "scripts/runner/standard-runner-actor181/joint/ba_observer_launcher181.mjs": "25d926c37cd27d38f389566214c3791711867f0f",
    "scripts/runner/standard-runner-actor181/joint/ba_observer_wrapper181.ps1": "7bc17f8ed503ea930146682576a9bbd1373b5369",
    "scripts/runner/standard-runner-actor181/joint/captured_pair_launch181.mjs": "3f68b6ec506c9ca32f4c73cbbffd981221d170f7",
    "scripts/runner/standard-runner-actor181/joint/joint_runtime211.mjs": "3992cf85b900ff61845b67401dc3175ef480d4a9",
    "scripts/runner/standard-runner-actor181/joint/provider_client_runtime181.ps1": "af2cfd06c8513d63712fda9e54e768d26582bda0",
    "scripts/runner/standard-runner-actor181/joint/relay_stdio_wrapper181.ps1": "3f846fd7999fb58644366fd565d6e77d56f1dcb3",
    "scripts/runner/standard-runner-actor181/joint/runner_entry_runtime181.ps1": "158bd6052ff4d6293e9144a56e2caedd66faf5f5",
    "scripts/runner/standard-runner-actor181/joint/runner_pipe_wrapper_runtime181.ps1": "f0a7a64f9b6c3cb1f16185b1e6f8ea53e1b250f5",
    "scripts/runner/standard-runner-actor181/joint/runner_spawn_transport211.mjs": "87d38a8ac033b1dcabbd3e1b6529fa4ff665a22e",
    "scripts/runner/standard-runner-actor181/maintenance-pipeline215.mjs": "525badec3fe0c4bb87dc5416d6b0961b0ac5876c",
    "scripts/runner/standard-runner-actor181/node-ingress/node-authority212.mjs": "c6b70d63678e3eb53b1f1034b1d4092a47355e1c",
    "scripts/runner/standard-runner-actor181/node-ingress/node_broker212.ps1": "0b481942c33e260a901138b958d641b4c9b96163",
    "scripts/runner/standard-runner-actor181/node-ingress/protocol212.mjs": "8110bed59bfafb681e959c0885c48e127421f870",
    "scripts/runner/standard-runner-actor181/node-ingress/root_node_ingress212.ps1": "e83ffedb4532cecb18ed97740eb42f2c6cced0bc",
    "scripts/runner/standard-runner-actor181/node-ingress/selector-wait212.mjs": "2c599dff01320fe14517a8083f498070c8f1eca6",
    "scripts/runner/standard-runner-actor181/node-runtime/read-node-primary.mjs": "170eef331ebfe8a050f7aa4280ecac137ff0a359",
    "scripts/runner/standard-runner-actor181/node-runtime/runtime-projection.mjs": "85d3dfe3e8cae122154ca0f2d9461ef2b895332f",
    "scripts/runner/standard-runner-actor181/provider-core.mjs": "c8430881e90c8fd2d18f40f7e911021fa0f1add9",
    "scripts/runner/standard-runner-actor181/self-install/captured-members215.json": "c62b84331cb460110f7aa6d122af935883ccec78",
    "scripts/runner/standard-runner-actor181/self-install/core.ps1": "54fc663749a31356c026d3904be7d982f2b8a0f1",
    "scripts/runner/standard-runner-actor181/self-install/definition.ps1": "e4b97f833e294c83ceee80a8a45be7ad14480553",
    "scripts/runner/standard-runner-actor181/self-install/enrollment_adapter.ps1": "a7db800d386273b553c2e301daeabe5582fa3941",
    "scripts/runner/standard-runner-actor181/self-install/enrollment_code.py": "308018ae2b5b6b3f68312231fe40b5ad38bacc31",
    "scripts/runner/standard-runner-actor181/self-install/install_protocol215.mjs": "f11e5b395101004265483affa92f8b6ba0c23505",
    "scripts/runner/standard-runner-actor181/self-install/install_spawn215.mjs": "efcf3b445cae1a1af9bafb8ca2aaa66d83ba4473",
    "scripts/runner/standard-runner-actor181/self-install/install_wrapper215.ps1": "639dcdf0a72fdb23ac90ab7eea135c45583cd64b",
    "scripts/runner/standard-runner-actor181/self-install/namespace.ps1": "c06ccffa1291cf2e96baac203e65aa9faa4b11ae",
    "scripts/runner/standard-runner-actor181/self-install/node_broker212.ps1": "8d1278a6650007263f64da0f0f9bb539cedd6de2",
    "scripts/runner/standard-runner-actor181/self-install/node_capture_pins215.json": "4a2e2fb82eccfcb7d364a42a50bd69f54887123a",
    "scripts/runner/standard-runner-actor181/self-install/node_install_authority215.mjs": "1b2183dd1e3927cc5f03e541f71e1ce07c2ba613",
    "scripts/runner/standard-runner-actor181/self-install/protocol212.mjs": "8110bed59bfafb681e959c0885c48e127421f870",
    "scripts/runner/standard-runner-actor181/self-install/registration.ps1": "a0bd5f4903026ab22640f7f3dad368c9ffa65d53",
    "scripts/runner/standard-runner-actor181/self-install/run_install215.mjs": "e16b359b14dfb226beb132c1113e7451ab0605ca",
    "scripts/runner/standard-runner-actor181/self-install/selector_wait218.mjs": "ec9824be8b97a6c2ef9966bc646860592903c252",
    "scripts/runner/standard-runner-actor181/self-install/self_helpers.ps1": "2290c59783fb56e7d2e44033dc43e5e4476c830c",
    "scripts/runner/standard-runner-actor181/self-install/xml_helpers.ps1": "e5edafc9be5ac12fde9e17eb2a98ba8652391d53",
    "scripts/runner/standard-runner-actor181/server/authority_server181.ps1": "d654748c5c624413794c20c5d19938357a6b4de5",
    "scripts/runner/standard-runner-actor181/server/closed-spawn-and-authority-abi181.json": "e68907bced5bb28e0dd1f326cb4311700f3ea8fa",
    "scripts/runner/standard-runner-actor181/server/provider_client181.ps1": "5acd7de2f89627d924c76a333601822be284d570",
    "scripts/runner/standard-runner-actor181/server/runner_pipe_wrapper181.ps1": "8092f2155f09802b9c295ffed2acc99d5e7fcbf1",
    "scripts/runner/standard-runner-actor181/server/runner_spawn_transport181.mjs": "3c6b564a4c926ca3aefc128d280025c7464ad42b",
    "scripts/runner/standard-runner-actor181/source-capture.mjs": "ad1394b86016e6cacde8b63b006daa3267829cd9",
    "scripts/runner/standard-runner-actor181/source-manifest.json": "8512c315eb8545c02b4b47f8e80ca6ca52442c2e"
  }
});
export const MERGE_RECONCILE_CONTROL_WORKFLOW_FILES=freeze({
  [MERGE_RECONCILE_CONTROL_SOURCE.file]:{family:'trusted_main_secret_reconcile_controller'},
});
export const CONTROL_WORKFLOW_FILES=freeze({...REPORTER_CONTROL_WORKFLOW_FILES,...MAIN_SECRET_CONTROL_WORKFLOW_FILES,...MERGE_RECONCILE_CONTROL_WORKFLOW_FILES});
// A distinct exact Source can extend the dispatch menu without migrating its
// route or changing any job. This metadata does not authorize its target actor.
export const DISPATCHER_CHOICE_SOURCE=freeze({
  file:'.github/workflows/clued-work-admission-dispatch.yml',
  choice:'clued-standard-runner-actor-qualification.yml',
  workflow_blob:'6f9410a9b33d8055fcc5044c4f87c2612b4aca93',
  source_sha256:'6ed9642dd95e4d116011f9cece441666d48838406ca3932022a8a39ff124697b',
  workflow_definition_sha256:'776e422564ecc9e00ca10150f95898c1904913f52a8213c0ed1c4580e4f33749',
  role_digests:{admit:'f3ff23059cbc216ed45040028e2c8ad96cfd4a71ead978a57ac6f1dd66f0f74a'},
  implementation_blobs:{
  ".github/actions/ci-temporary-storage/action.yml": "72a78ada2553dc42a062dbccf310d1b23e65431f",
  ".github/actions/ci-temporary-storage/check-workflows.mjs": "bd30bbb8527d86a9e3c2bd2aafe07e0eb1a342fc",
  ".github/actions/ci-temporary-storage/coverage.json": "01e05e15b80fcf1f0431e71d8aa05d1584aa8d0d",
  ".github/actions/ci-temporary-storage/setup.mjs": "dd162105b2800d31b9970d25575945a140a69d42",
  ".github/actions/ci-temporary-storage/setup.py": "4e3f82e061162f894e310f6e767bacf8c57a079b",
  ".github/workflows/clued-standard-runner-actor-qualification.yml": "d752e91ae501313396163df277883d2d02fa100e",
  "apps/clued-cloud/app/supabase-public-config.ts": "193fedd8e9d5ccaea873e2cc4d0efd894e93d6ae",
  "config/clued-handover-native-entry-policy.json": "2a26987dfc41458a6db005f144dd07fd49ee8644",
  "config/merge-admission-policy.json": "a54ea27028f6361765fffce30f9ffa227a91b2ea",
  "scripts/ci/clued-gated-proof-profiles.json": "ef4270fd72819d3f4cbab5ddb4484426e337f720",
  "scripts/ci/clued-gated-proof-role-specs.json": "81f2a2bed2113dde22f260733234f954180ac0c6",
  "scripts/ci/clued-gated-proof-runtime.mjs": "c7884078fee3afbf98681425982051a87df38ce9",
  "scripts/ci/clued-handover-native-entry.mjs": "d6682bdece007f142bd53185d70427c7eb3e7f7c",
  "scripts/ci/clued-merge-slot-ci.mjs": "b26a73bc6e05c4917d236a15e62b5ff01955f7b0",
  "scripts/ci/clued-production-publisher-source.mjs": "0e3c2d4df3fb2f4ceb6ec8750028e2b046a1a0b6",
  "scripts/ci/clued-production-publisher-sources.json": "df10a840de4d00961d9df55103e6c6849fba23fb",
  "scripts/ci/clued-publisher-qualification-source.mjs": "f38859449e35eeeef492db8130f91c266c208d75",
  "scripts/ci/clued-publisher-qualification-sources.json": "34bbd3c400af8565ed28545af2ba839c5f920d40",
  "scripts/ci/clued-scan-start.mjs": "07042a02682d818f7e51a8d4e6105d7cc58c4b27",
  "scripts/ci/clued-standard-runner-actor-source.mjs": "e8de9a37f939941fc5ce05627c08e2db57a298e6",
  "scripts/ci/clued-standard-runner-actor-sources.json": "5112f5f0102fd7f9828fe96b0b07930f77dd0e6e",
  "scripts/ci/clued-work-admission.mjs": "525b46a283117a735f5891340563be57b529625d",
  "scripts/ci/clued-workflow-profile.mjs": "69622ceef577da9e4eb8dab25fed4bdc1cbb50f3",
  "scripts/ci/merge-admission-measurement-history.mjs": "6799c148ee7baf51a5ba989de73fb8bffb054f6f",
  "scripts/ci/merge-admission-policy.mjs": "a3f6830e0087474d3e36222d12975deb7830c4d3",
  "scripts/ci/merge-admission-source-producer.mjs": "2f428d400de4dbf0a9feca2bd27269c0dd353033",
  "scripts/runner/clued-runner-job-started.mjs": "dd6dcaf875539c23a9e87726542de8179a81456a",
  "scripts/runner/qualify-standard-runner-actor.mjs": "794861b9acf7659ef2bb946f2c1dff7ef33fbd10"

  },
});
const mainSecretBoundary=freeze({
  proof_classification:'trusted_main_secret_controller_source_only',execution_authority:false,
  host_qualification:'separate_required',runner_hook_exception:false,
  dispatch_authority:false,production_authority:false,canonical_authority:false,
  credentials:'existing_clued_admission_environment_and_native_job_token',stored_secrets:true,
});
const boundary=freeze({
  proof_classification:'trusted_controller_source_only',execution_authority:false,
  host_qualification:'separate_required',runner_hook_exception:false,
  dispatch_authority:false,production_authority:false,canonical_authority:false,
  credentials:'native_job_GITHUB_TOKEN_only',stored_secrets:false,
});
const hash=text=>createHash('sha256').update(text).digest('hex');
const plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const canonical=x=>Array.isArray(x)?x.map(canonical):plain(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const same=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
const keys=(value,names)=>plain(value)&&same(Object.keys(value).sort(),[...names].sort());
const sha=/^[a-f0-9]{40}$/,digest=/^[a-f0-9]{64}$/;
const bad=reason=>{throw Error('unregistered control Source: '+reason);};
const unknown=reason=>({passed:false,state:'unknown',reason});

function rolesForDefinition(value,accepted_roles){
  const ids=Object.keys(value.jobs).sort();
  if(!Array.isArray(accepted_roles)||accepted_roles.length!==ids.length||
      new Set(accepted_roles.map(r=>r?.job_id)).size!==ids.length||
      accepted_roles.some(r=>!keys(r,['job_id','definition_sha256','definition'])||!ids.includes(r.job_id)||
        !plain(r.definition)||!digest.test(r.definition_sha256)||
        r.definition_sha256!==roleDefinitionDigest(r.definition)||!same(r.definition,value.jobs[r.job_id])))
    bad('complete independent job roles');
  return Object.fromEntries(ids.map(id=>[id,accepted_roles.find(r=>r.job_id===id).definition_sha256]));
}

function controllerRoute(file,route){
  // A selector is only Source data. It does not register a runner or prove that
  // the Host is isolated. This sole general-pool successor is the trusted-main
  // status reporter: its candidate SHA stays data and its native token is kept.
  if(file==='.github/workflows/public-mcp-gate-receipt.yml')return same(route,PUBLIC_REPORTER_CONTROLLER_ROUTE);
  // No real memory-verifier successor is enrolled. This bounded compiler path
  // supports test-only Source fixtures; the actual nonmain-base hook still denies.
  return Array.isArray(route)&&route.length>=4&&route.length<=12&&
    route.every(label=>typeof label==='string'&&/^[A-Za-z0-9._-]{1,80}$/.test(label))&&
    new Set(route.map(label=>label.toLowerCase())).size===route.length&&
    ['self-hosted','Linux','X64','clued-control'].every(label=>route.includes(label))&&
    !route.some(label=>/^(?:ubuntu|windows|macos)-/i.test(label)||/^(?:pool-general|windows|macos)$/i.test(label));
}

// Registration must supply the locked YAML parser and separately reviewed full
// role digests. Only a literal route of the existing hosted job may change.
export function compileControlWorkflowSource(file,text,{parseYaml,accepted_roles,
  source_kind='controller_successor',predecessor}={}){
  const descriptor=Object.hasOwn(CONTROL_WORKFLOW_FILES,file)?CONTROL_WORKFLOW_FILES[file]:null;
  if(!descriptor||typeof text!=='string'||!text||Buffer.byteLength(text)>131072||typeof parseYaml!=='function'||
      /\r(?!\n)|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u0085\u2028\u2029]/.test(text))bad('identity/source/parser');
  if(!['legacy_predecessor','controller_successor','completion_observer_successor','dispatcher_choice_successor','retired_consumer_observer_successor','merge_reconcile_initial'].includes(source_kind)||
    source_kind==='completion_observer_successor'&&file!==SLOT_COMPLETION_OBSERVER_SOURCE.file||
    source_kind==='dispatcher_choice_successor'&&file!==DISPATCHER_CHOICE_SOURCE.file||
    source_kind==='retired_consumer_observer_successor'&&file!==RETIRED_CONSUMER_OBSERVER_SOURCE.file||
    source_kind==='merge_reconcile_initial'&&file!==MERGE_RECONCILE_CONTROL_SOURCE.file)bad('source kind');
  const value=parseYaml(text);
  if(descriptor.family==='trusted_main_secret_reconcile_controller')return compileInitialReconcileController(file,text,value,{accepted_roles,source_kind,predecessor});
  if(descriptor.family==='trusted_main_secret_controller')return compileMainSecretController(file,text,value,{parseYaml,accepted_roles,source_kind,predecessor,descriptor});
  if(!plain(value)||!plain(value.jobs)||Object.keys(value.jobs).length!==2||
      !plain(value.jobs[descriptor.migrating_job])||
      Object.values(value.jobs).some(job=>!plain(job)||job.environment!==undefined||job.uses!==undefined)||
      /\bsecrets\s*(?:\.|\[)/i.test(text))bad('two concrete jobs without environment or stored Secrets');
  const role_digests=rolesForDefinition(value,accepted_roles);
  let predecessor_blob=null;
  if(source_kind==='legacy_predecessor'){
    if(workflowBlob(text)!==descriptor.predecessor_blob||hash(text)!==descriptor.predecessor_sha256||
        roleDefinitionDigest(value)!==descriptor.predecessor_definition_sha256)bad('exact immutable predecessor');
  }else{
    if(!predecessor||predecessor.source_kind!=='legacy_predecessor')bad('exact predecessor required');
    const old=compileControlWorkflowSource(file,predecessor.source_yaml,{
      parseYaml:()=>predecessor.workflow_definition,source_kind:'legacy_predecessor',
      accepted_roles:Object.entries(predecessor.role_digests??{}).map(([job_id,definition_sha256])=>({job_id,definition_sha256,
        definition:predecessor.workflow_definition?.jobs?.[job_id]})),
    });
    if(!same(old,predecessor))bad('predecessor integrity');
    const before=structuredClone(old.workflow_definition),after=structuredClone(value);
    if(!controllerRoute(file,after.jobs[descriptor.migrating_job]['runs-on']))bad('literal registered-family controller route required');
    delete before.jobs[descriptor.migrating_job]['runs-on'];
    delete after.jobs[descriptor.migrating_job]['runs-on'];
    // Includes trigger filters, native-event/Owner conditions, trusted checkout,
    // permissions, token source, real commands, status writes and receipt output.
    if(!same(before,after))bad('only the named hosted route may change');
    predecessor_blob=old.workflow_blob;
  }
  const commands={};
  for(const [id,job]of Object.entries(value.jobs)){
    const names={};
    for(const step of job.steps??[]){
      if(step.run===undefined)continue;
      if(typeof step.run!=='string'||!step.run.trim())bad('actual command');
      const name=step.name??('Run '+step.run.split('\n')[0]);
      (names[name]??=[]).push(hash(step.run.replace(/\r\n/g,'\n').trimEnd()));
    }
    commands[id]=names;
  }
  return {registration_status:'registered',family:descriptor.family,source_kind,
    operation:source_kind==='legacy_predecessor'?'predecessor':'migrate_hosted_controller',
    workflow_blob:workflowBlob(text),source_sha256:hash(text),source_yaml:text,
    workflow_definition:value,predecessor_blob,primary_ids:Object.keys(value.jobs).sort(),
    role_digests,command_digests:commands,implementation_blobs:{...descriptor.implementation_blobs},
    authority_boundary:{...boundary}};
}

function compileInitialReconcileController(file,text,value,{accepted_roles,source_kind,predecessor}){
  const pin=MERGE_RECONCILE_CONTROL_SOURCE;
  if(file!==pin.file||source_kind!=='merge_reconcile_initial'||predecessor!==undefined&&predecessor!==null||
    workflowBlob(text)!==pin.workflow_blob||hash(text)!==pin.source_sha256||
    !plain(value)||!plain(value.jobs)||roleDefinitionDigest(value)!==pin.workflow_definition_sha256)
    bad('exact initial reconciliation Source required without a predecessor');
  const role_digests=rolesForDefinition(value,accepted_roles);
  if(!same(role_digests,pin.role_digests))bad('exact complete reconciliation FullRole required');
  const commands={};
  for(const [id,job]of Object.entries(value.jobs)){
    const names={};for(const step of job.steps??[]){if(step.run===undefined)continue;
      if(typeof step.run!=='string'||!step.run.trim())bad('reconciliation actual command');
      const name=step.name??('Run '+step.run.split('\n')[0]);
      (names[name]??=[]).push(hash(step.run.replace(/\r\n/g,'\n').trimEnd()));
    }commands[id]=names;
  }
  return {registration_status:'registered',family:'trusted_main_secret_reconcile_controller',source_kind,
    operation:'register_initial_reconciliation_controller',workflow_blob:workflowBlob(text),source_sha256:hash(text),
    source_yaml:text,workflow_definition:value,predecessor_blob:null,primary_ids:Object.keys(value.jobs).sort(),
    role_digests,command_digests:commands,implementation_blobs:{...pin.implementation_blobs},authority_boundary:{...mainSecretBoundary}};
}

// A separate family retains the exact existing privileged environment and
// commands. It never borrows the public reporter's no-stored-secret boundary.
function compileMainSecretController(file,text,value,{parseYaml,accepted_roles,source_kind,predecessor,descriptor}){
  if(!plain(value)||!plain(value.jobs)||!same(Object.keys(value.jobs).sort(),[...descriptor.migrating_jobs].sort())||
    Object.values(value.jobs).some(job=>!plain(job)||job.environment!=='clued-admission'||job.uses!==undefined))
    bad('exact main-secret controller jobs/environment');
  const role_digests=rolesForDefinition(value,accepted_roles);let predecessor_blob=null;
  if(source_kind==='completion_observer_successor'){
    const pin=SLOT_COMPLETION_OBSERVER_SOURCE;
    if(file!==pin.file||workflowBlob(text)!==pin.workflow_blob||hash(text)!==pin.source_sha256||
      roleDefinitionDigest(value)!==pin.workflow_definition_sha256||!same(role_digests,pin.role_digests))
      bad('exact slot completion-observer Source/FullRole required');
  }
  if(source_kind==='retired_consumer_observer_successor'){
    const pin=RETIRED_CONSUMER_OBSERVER_SOURCE;
    if(file!==pin.file||workflowBlob(text)!==pin.workflow_blob||hash(text)!==pin.source_sha256||
      roleDefinitionDigest(value)!==pin.workflow_definition_sha256||!same(role_digests,pin.role_digests))
      bad('exact retired-consumer observer Source/FullRole required');
  }
  if(source_kind==='dispatcher_choice_successor'){
    const pin=DISPATCHER_CHOICE_SOURCE;
    if(file!==pin.file||workflowBlob(text)!==pin.workflow_blob||hash(text)!==pin.source_sha256||
      roleDefinitionDigest(value)!==pin.workflow_definition_sha256||!same(role_digests,pin.role_digests))
      bad('exact dispatcher-choice Source/FullRole required');
  }
  if(source_kind==='legacy_predecessor'){
    if(workflowBlob(text)!==descriptor.predecessor_blob||hash(text)!==descriptor.predecessor_sha256||
      roleDefinitionDigest(value)!==descriptor.predecessor_definition_sha256)bad('exact main-secret predecessor');
  }else{
    if(!predecessor||predecessor.source_kind!=='legacy_predecessor')bad('exact main-secret predecessor required');
    const old=compileControlWorkflowSource(file,predecessor.source_yaml,{parseYaml:()=>predecessor.workflow_definition,
      source_kind:'legacy_predecessor',accepted_roles:Object.entries(predecessor.role_digests??{}).map(([job_id,definition_sha256])=>
        ({job_id,definition_sha256,definition:predecessor.workflow_definition?.jobs?.[job_id]}))});
    if(!same(old,predecessor))bad('main-secret predecessor integrity');
    const before=structuredClone(old.workflow_definition),after=structuredClone(value);
    if(source_kind==='controller_successor')for(const id of descriptor.migrating_jobs){
      if(!same(after.jobs[id]['runs-on'],MAIN_SECRET_CONTROLLER_ROUTE))bad('exact dedicated main-secret controller route');
      delete before.jobs[id]['runs-on'];delete after.jobs[id]['runs-on'];
    }
    if(source_kind==='dispatcher_choice_successor'){
      const previous=before.on?.workflow_dispatch?.inputs?.workflow?.options,
        actual=after.on?.workflow_dispatch?.inputs?.workflow?.options,choice=DISPATCHER_CHOICE_SOURCE.choice;
      if(!Array.isArray(previous)||previous.includes(choice)||!Array.isArray(actual)||
        actual.length!==previous.length+1||actual.at(-1)!==choice||!same(actual.slice(0,-1),previous))
        bad('only append the one exact dispatcher choice');
      after.on.workflow_dispatch.inputs.workflow.options=structuredClone(previous);
    }
    // The old Windows-route successor adds only budget. The distinct exact
    // observer Source keeps the predecessor route and every job byte while
    // adding exactly these two notification names, each once. Neither form
    // may reorder old signals or change any other trigger field. Retirement
    // is a separate exact Source that removes only its one pinned old signal.
    if(file===SLOT_COMPLETION_OBSERVER_SOURCE.file){
      const previous=before.on?.workflow_run?.workflows,actual=after.on?.workflow_run?.workflows,
        additions=['completion_observer_successor','retired_consumer_observer_successor'].includes(source_kind)?['runner-budget-policy','clued-required-tests']:['runner-budget-policy'];
      const oldSignals=source_kind==='retired_consumer_observer_successor'?previous?.filter(name=>name!==RETIRED_CONSUMER_OBSERVER_SOURCE.removed_workflow):previous;
      if(source_kind==='retired_consumer_observer_successor'){
        if(!Array.isArray(previous)||previous.filter(name=>name===RETIRED_CONSUMER_OBSERVER_SOURCE.removed_workflow).length!==1||actual?.includes(RETIRED_CONSUMER_OBSERVER_SOURCE.removed_workflow))bad('only the retired consumer notification may be removed');
        before.on.workflow_run.workflows=structuredClone(oldSignals);
      }
      if(!Array.isArray(previous)||additions.some(name=>previous.includes(name))||!Array.isArray(actual)||
        actual.length!==oldSignals.length+additions.length||additions.some(name=>actual.filter(value=>value===name).length!==1)||
        !same(actual.filter(name=>!additions.includes(name)),oldSignals))bad('exact slot completion observer delta required');
      after.on.workflow_run.workflows=structuredClone(oldSignals);
    }
    // All remaining triggers, main checkout, permissions, secret references,
    // cancellation, timeouts, exact-head gates and commands stay frozen.
    if(!same(before,after))bad('main-secret controller bounded successor');
    predecessor_blob=old.workflow_blob;
  }
  const commands={};
  for(const [id,job]of Object.entries(value.jobs)){
    const names={};for(const step of job.steps??[]){if(step.run===undefined)continue;
      if(typeof step.run!=='string'||!step.run.trim())bad('main-secret actual command');
      const name=step.name??('Run '+step.run.split('\n')[0]);
      (names[name]??=[]).push(hash(step.run.replace(/\r\n/g,'\n').trimEnd()));
    }commands[id]=names;
  }
  return {registration_status:'registered',family:descriptor.family,source_kind,
    operation:source_kind==='legacy_predecessor'?'predecessor':source_kind==='completion_observer_successor'?'extend_completion_observer':source_kind==='retired_consumer_observer_successor'?'retire_completed_consumer_signal':source_kind==='dispatcher_choice_successor'?'extend_dispatcher_choice':'migrate_hosted_controller',workflow_blob:workflowBlob(text),
    source_sha256:hash(text),source_yaml:text,workflow_definition:value,predecessor_blob,
    primary_ids:[...descriptor.migrating_jobs].sort(),role_digests,command_digests:commands,
    implementation_blobs:{...(source_kind==='legacy_predecessor'?descriptor.predecessor_implementation_blobs:
      source_kind==='completion_observer_successor'?SLOT_COMPLETION_OBSERVER_SOURCE.implementation_blobs:
      source_kind==='retired_consumer_observer_successor'?RETIRED_CONSUMER_OBSERVER_SOURCE.implementation_blobs:
      source_kind==='dispatcher_choice_successor'?DISPATCHER_CHOICE_SOURCE.implementation_blobs:descriptor.implementation_blobs)},authority_boundary:{...mainSecretBoundary}};
}

// Callers must read this catalogue from a verified trusted-main snapshot. A PR
// catalogue, matching label or this result alone supplies no execution authority.
export function registeredControlWorkflowSource(registry,file,text,{repository='tdoljyj/cross-memory-system'}={}){
  try{
    if(!keys(registry,['schema','repository','default_branch','workflows','roles'])||
        registry.schema!==CONTROL_WORKFLOW_SOURCE_SCHEMA||registry.repository!=='tdoljyj/cross-memory-system'||
        registry.repository!==repository||registry.default_branch!=='main'||
        !plain(registry.workflows)||!plain(registry.roles)||
        !same(Object.keys(registry.workflows).sort(),Object.keys(CONTROL_WORKFLOW_FILES).sort())||
        !same(Object.keys(registry.workflows).sort(),Object.keys(registry.roles).sort()))return unknown('control catalogue identity');
    const descriptor=CONTROL_WORKFLOW_FILES[file],root=registry.workflows[file],roles=registry.roles[file];
    if(!descriptor||!keys(root,['registration_status','sources'])||root.registration_status!=='registered'||
        !Array.isArray(root.sources)||root.sources.length<1||root.sources.length>(file===RETIRED_CONSUMER_OBSERVER_SOURCE.file?4:3)||!plain(roles)||typeof text!=='string'||
        root.sources.some(source=>!plain(source)||!sha.test(source.workflow_blob??''))||
        new Set(root.sources.map(source=>source.workflow_blob)).size!==root.sources.length||
        !same(Object.keys(roles).sort(),root.sources.map(source=>source.workflow_blob).sort()))return unknown('control catalogue bounds');
    if(descriptor.family==='trusted_main_secret_reconcile_controller'){
      if(root.sources.length!==1||root.sources[0].source_kind!=='merge_reconcile_initial'||root.sources[0].predecessor_blob!==null)
        return unknown('unique initial reconciliation Source required without a predecessor');
      const source=root.sources[0],compiled=compileControlWorkflowSource(file,source.source_yaml,{
        parseYaml:()=>source.workflow_definition,accepted_roles:roles[source.workflow_blob],source_kind:'merge_reconcile_initial',
      });
      if(!same(source,compiled)||source.workflow_blob!==workflowBlob(text)||source.source_yaml!==text||source.source_sha256!==hash(text))
        return unknown('initial reconciliation Source/FullRole differs');
      return {passed:true,state:'qualified',scope:'registered_control_source_only',profile:source,
        required_implementation_blobs:{...source.implementation_blobs},authority_boundary:{...source.authority_boundary}};
    }
    const predecessors=root.sources.filter(source=>source.source_kind==='legacy_predecessor');
    if(predecessors.length!==1)return unknown('unique control predecessor missing');
    const predecessor=predecessors[0],compiledPredecessor=compileControlWorkflowSource(file,predecessor.source_yaml,{
      parseYaml:()=>predecessor.workflow_definition,accepted_roles:roles[predecessor.workflow_blob],source_kind:'legacy_predecessor',
    });
    if(!same(predecessor,compiledPredecessor))return unknown('control predecessor integrity');
    for(const source of root.sources){
      const compiled=source.source_kind==='legacy_predecessor'?compiledPredecessor:compileControlWorkflowSource(file,source.source_yaml,{
        parseYaml:()=>source.workflow_definition,accepted_roles:roles[source.workflow_blob],source_kind:source.source_kind,predecessor,
      });
      if(!same(source,compiled))return unknown('compiled control Source/Role differs');
    }
    const matches=root.sources.filter(source=>source.workflow_blob===workflowBlob(text));
    if(matches.length!==1||matches[0].source_yaml!==text||matches[0].source_sha256!==hash(text))return unknown('exact control Git bytes absent');
    return {passed:true,state:'qualified',scope:'registered_control_source_only',profile:matches[0],
      required_implementation_blobs:{...matches[0].implementation_blobs},authority_boundary:{...matches[0].authority_boundary}};
  }catch{return unknown('control Source integrity');}
}

// For a future admission/catalogue integration only. Neither runtime nor runner
// hooks call this module yet. Renames/copies/new paths cannot borrow the pair.
export function registeredControlWorkflowTransition(registry,file,headText,baseText,{repository,change}={}){
  if(file===MERGE_RECONCILE_CONTROL_SOURCE.file){
    if(!change||change.status!=='added'||change.filename!==file||change.previous_filename!==undefined||baseText!==null)
      return unknown('exact initial added reconciliation path with absent base required');
    const head=registeredControlWorkflowSource(registry,file,headText,{repository});
    if(!head.passed||head.profile.source_kind!=='merge_reconcile_initial'||head.profile.predecessor_blob!==null)
      return unknown('registered initial reconciliation Source absent');
    return {...head,scope:'registered_control_transition_source_only'};
  }
  if(!change||change.status!=='modified'||change.filename!==file||
      change.previous_filename!==undefined&&change.previous_filename!==file||
      typeof baseText!=='string'||headText===baseText)return unknown('exact modified controller identity required');
  const head=registeredControlWorkflowSource(registry,file,headText,{repository});
  const base=registeredControlWorkflowSource(registry,file,baseText,{repository});
  if(!head.passed||!base.passed)return unknown('registered controller predecessor/successor absent');
  const retirement=head.profile.source_kind==='retired_consumer_observer_successor'&&file===RETIRED_CONSUMER_OBSERVER_SOURCE.file&&
    ((base.profile.source_kind==='completion_observer_successor'&&base.profile.workflow_blob===RETIRED_CONSUMER_OBSERVER_SOURCE.retired_from_blob)||
     (base.profile.source_kind==='legacy_predecessor'&&base.profile.workflow_blob===RETIRED_CONSUMER_OBSERVER_SOURCE.legacy_from_blob));
  const legacy=(head.profile.source_kind==='controller_successor'||
    file===SLOT_COMPLETION_OBSERVER_SOURCE.file&&head.profile.source_kind==='completion_observer_successor'||
    file===DISPATCHER_CHOICE_SOURCE.file&&head.profile.source_kind==='dispatcher_choice_successor')&&
    base.profile.source_kind==='legacy_predecessor'&&head.profile.predecessor_blob===base.profile.workflow_blob;
  if(!retirement&&!legacy)return unknown('registered controller predecessor/successor absent');
  return {...head,scope:'registered_control_transition_source_only'};
}

export const RETIRED_CONSUMER_OBSERVER_SOURCE=freeze({
  "file": ".github/workflows/clued-merge-slot-ci.yml",
  "removed_workflow": "Clued handover hook qualification / home-linux-01",
  "retired_from_blob": "759fd82dc328fba0aa663e2c6c8c9aa516292294",
  "legacy_from_blob": "662dbc3e846311379efa5f081b3cca518a881f74",
  "workflow_blob": "b2178adc5af19d0eaea359616388edf7fb7d3446",
  "source_sha256": "f8ae06eb8a2e1cbe6b0ff91514067f7c216f6551fdf8cf3a8c24e0715a53abfa",
  "workflow_definition_sha256": "7afc41da478eda7b1373defcb0a4d746556cc8acccd91592db32d946773ff3c6",
  "role_digests": {
    "report": "becc90f293b687326328f684eae049bd17985ef259db9db6bf501f7ad027b63d"
  },
  "implementation_blobs": {
    ".github/actions/ci-temporary-storage/action.yml": "72a78ada2553dc42a062dbccf310d1b23e65431f",
    ".github/actions/ci-temporary-storage/check-workflows.mjs": "bd30bbb8527d86a9e3c2bd2aafe07e0eb1a342fc",
    ".github/actions/ci-temporary-storage/coverage.json": "12f0ff5aca09df465aa0461d493485c3ed2c65b1",
    ".github/actions/ci-temporary-storage/setup.mjs": "dd162105b2800d31b9970d25575945a140a69d42",
    ".github/actions/ci-temporary-storage/setup.py": "4e3f82e061162f894e310f6e767bacf8c57a079b",
    ".github/workflows/clued-standard-runner-actor-qualification.yml": "d752e91ae501313396163df277883d2d02fa100e",
    "apps/clued-cloud/app/supabase-public-config.ts": "193fedd8e9d5ccaea873e2cc4d0efd894e93d6ae",
    "config/clued-handover-native-entry-policy.json": "2a26987dfc41458a6db005f144dd07fd49ee8644",
    "config/merge-admission-policy.json": "a54ea27028f6361765fffce30f9ffa227a91b2ea",
    "scripts/ci/clued-gated-proof-profiles.json": "05650ffd3d4f5c9d8c1cde6aab1668838eaddbd4",
    "scripts/ci/clued-gated-proof-role-specs.json": "28a2750730f1d9c9d22759d67acdf7c35985cb5b",
    "scripts/ci/clued-gated-proof-runtime.mjs": "c7884078fee3afbf98681425982051a87df38ce9",
    "scripts/ci/clued-handover-native-entry.mjs": "d6682bdece007f142bd53185d70427c7eb3e7f7c",
    "scripts/ci/clued-merge-slot-ci.mjs": "b26a73bc6e05c4917d236a15e62b5ff01955f7b0",
    "scripts/ci/clued-production-publisher-source.mjs": "0e3c2d4df3fb2f4ceb6ec8750028e2b046a1a0b6",
    "scripts/ci/clued-production-publisher-sources.json": "df10a840de4d00961d9df55103e6c6849fba23fb",
    "scripts/ci/clued-publisher-qualification-source.mjs": "f38859449e35eeeef492db8130f91c266c208d75",
    "scripts/ci/clued-publisher-qualification-sources.json": "34bbd3c400af8565ed28545af2ba839c5f920d40",
    "scripts/ci/clued-scan-start.mjs": "07042a02682d818f7e51a8d4e6105d7cc58c4b27",
    "scripts/ci/clued-standard-runner-actor-source.mjs": "e8de9a37f939941fc5ce05627c08e2db57a298e6",
    "scripts/ci/clued-standard-runner-actor-sources.json": "5112f5f0102fd7f9828fe96b0b07930f77dd0e6e",
    "scripts/ci/clued-work-admission.mjs": "b6d65b5987aed5442ddb89087950c2c4369644f2",
    "scripts/ci/clued-workflow-profile.mjs": "69622ceef577da9e4eb8dab25fed4bdc1cbb50f3",
    "scripts/ci/merge-admission-measurement-history.mjs": "6799c148ee7baf51a5ba989de73fb8bffb054f6f",
    "scripts/ci/merge-admission-policy.mjs": "a3f6830e0087474d3e36222d12975deb7830c4d3",
    "scripts/ci/merge-admission-source-producer.mjs": "2f428d400de4dbf0a9feca2bd27269c0dd353033",
    "scripts/runner/clued-runner-job-started.mjs": "263c9f53b42c66c385fdb808345170ead9462ccf",
    "scripts/runner/qualify-standard-runner-actor.mjs": "794861b9acf7659ef2bb946f2c1dff7ef33fbd10"
  }
});

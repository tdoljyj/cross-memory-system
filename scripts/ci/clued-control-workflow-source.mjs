// Exact Sources for two public reporters and five privileged main controllers. Event payloads are data;
// these are neither candidate application tests nor publisher qualifications.
import {createHash} from 'node:crypto';
import {roleDefinitionDigest,workflowBlob} from './clued-workflow-profile.mjs';

export const COMPONENT_VERSION='1.0.2';
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
export const CONTROL_WORKFLOW_FILES=freeze({...REPORTER_CONTROL_WORKFLOW_FILES,...MAIN_SECRET_CONTROL_WORKFLOW_FILES});
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
  if(!['legacy_predecessor','controller_successor','completion_observer_successor'].includes(source_kind)||
    source_kind==='completion_observer_successor'&&file!==SLOT_COMPLETION_OBSERVER_SOURCE.file)bad('source kind');
  const value=parseYaml(text);
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
    // The old Windows-route successor adds only budget. The distinct exact
    // observer Source keeps the predecessor route and every job byte while
    // adding exactly these two notification names, each once. Neither form
    // may remove/reorder old signals or change any other trigger field.
    if(file===SLOT_COMPLETION_OBSERVER_SOURCE.file){
      const previous=before.on?.workflow_run?.workflows,actual=after.on?.workflow_run?.workflows,
        additions=source_kind==='completion_observer_successor'?['runner-budget-policy','clued-required-tests']:['runner-budget-policy'];
      if(!Array.isArray(previous)||additions.some(name=>previous.includes(name))||!Array.isArray(actual)||
        actual.length!==previous.length+additions.length||additions.some(name=>actual.filter(value=>value===name).length!==1)||
        !same(actual.filter(name=>!additions.includes(name)),previous))bad('exact slot completion observer delta required');
      after.on.workflow_run.workflows=structuredClone(previous);
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
    operation:source_kind==='legacy_predecessor'?'predecessor':source_kind==='completion_observer_successor'?'extend_completion_observer':'migrate_hosted_controller',workflow_blob:workflowBlob(text),
    source_sha256:hash(text),source_yaml:text,workflow_definition:value,predecessor_blob,
    primary_ids:[...descriptor.migrating_jobs].sort(),role_digests,command_digests:commands,
    implementation_blobs:{...(source_kind==='legacy_predecessor'?descriptor.predecessor_implementation_blobs:
      source_kind==='completion_observer_successor'?SLOT_COMPLETION_OBSERVER_SOURCE.implementation_blobs:descriptor.implementation_blobs)},authority_boundary:{...mainSecretBoundary}};
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
        !Array.isArray(root.sources)||root.sources.length<1||root.sources.length>3||!plain(roles)||typeof text!=='string'||
        root.sources.some(source=>!plain(source)||!sha.test(source.workflow_blob??''))||
        new Set(root.sources.map(source=>source.workflow_blob)).size!==root.sources.length||
        !same(Object.keys(roles).sort(),root.sources.map(source=>source.workflow_blob).sort()))return unknown('control catalogue bounds');
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
  if(!change||change.status!=='modified'||change.filename!==file||
      change.previous_filename!==undefined&&change.previous_filename!==file||
      typeof baseText!=='string'||headText===baseText)return unknown('exact modified controller identity required');
  const head=registeredControlWorkflowSource(registry,file,headText,{repository});
  const base=registeredControlWorkflowSource(registry,file,baseText,{repository});
  if(!head.passed||!base.passed||!(head.profile.source_kind==='controller_successor'||
        file===SLOT_COMPLETION_OBSERVER_SOURCE.file&&head.profile.source_kind==='completion_observer_successor')||
      base.profile.source_kind!=='legacy_predecessor'||head.profile.predecessor_blob!==base.profile.workflow_blob)
    return unknown('registered controller predecessor/successor absent');
  return {...head,scope:'registered_control_transition_source_only'};
}

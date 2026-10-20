// Fixed actual successor byte pins, not a generic module registry.
export const ADAPTER_SUCCESSORS={
  "gitleaks": {
    "path": "work/actions-hosted-migration/independent-ci-v1/worker/formal-gitleaks-v3/adapter.mjs",
    "successorSha256": "032e2ecb68c01e4916e04b093ea6b3a8a9830afe87a5c30b99e18af323f3df6d"
  },
  "trivy": {
    "path": "work/actions-hosted-migration/independent-ci-v1/worker/formal-trivy-v3/adapter.mjs",
    "successorSha256": "b1c5041298cc51528e87d71cb9ea2fc5ea2bda03aaf3d977f0c11d803a570c6a"
  },
  "contract-placement": {
    "path": "work/actions-hosted-migration/independent-ci-v1/worker/formal-contract-placement-v1/adapter.mjs",
    "successorSha256": "32fe8e9db7c92a57e74e749446c4fc9156455cb7017af662d00bc8ca734321e8"
  }
};
for(const r of Object.values(ADAPTER_SUCCESSORS))Object.freeze(r);Object.freeze(ADAPTER_SUCCESSORS);

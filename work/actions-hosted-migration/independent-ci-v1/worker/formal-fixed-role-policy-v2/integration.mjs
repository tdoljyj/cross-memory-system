// Fixed actual successor byte pins, not a generic module registry.
export const ADAPTER_SUCCESSORS={
  "gitleaks": {
    "path": "work/actions-hosted-migration/independent-ci-v1/worker/formal-gitleaks-v3/adapter.mjs",
    "successorSha256": "58cf77ca550c2590596209750940cff5f027977f3e2f3d1d9e0a445c92682986"
  },
  "trivy": {
    "path": "work/actions-hosted-migration/independent-ci-v1/worker/formal-trivy-v3/adapter.mjs",
    "successorSha256": "b1c5041298cc51528e87d71cb9ea2fc5ea2bda03aaf3d977f0c11d803a570c6a"
  },
  "contract-placement": {
    "path": "work/actions-hosted-migration/independent-ci-v1/worker/formal-contract-placement-v1/adapter.mjs",
    "successorSha256": "9dda23c64015c85f8c52407f19f5ddafc4d519103db25f2ee1f63f17e36a2b91"
  }
};
for(const r of Object.values(ADAPTER_SUCCESSORS))Object.freeze(r);Object.freeze(ADAPTER_SUCCESSORS);

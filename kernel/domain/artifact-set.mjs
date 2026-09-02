import { createHash } from "node:crypto";

export class ArtifactSetError extends Error {
  constructor(code) {
    super(code);
    this.name = "ArtifactSetError";
    this.code = code;
  }
}
const sha = (bytes) => "sha256:" + createHash("sha256").update(bytes).digest("hex");
function reject(code) { throw new ArtifactSetError(code); }
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}
const digestObject = (value) => sha(Buffer.from(JSON.stringify(stable(value)), "utf8"));

export function verifyExternalArtifact(input, budget) {
  if (!Buffer.isBuffer(input.bytes) || input.truncated || input.bytes.length > budget.max_bytes) {
    reject("EXTERNAL_ARTIFACT_INCOMPLETE");
  }
  const actual = sha(input.bytes);
  if (actual !== input.expected_digest || input.bytes.length !== input.expected_size) {
    reject("EXTERNAL_ARTIFACT_DIGEST_MISMATCH");
  }
  return Object.freeze({
    actual_digest: actual,
    actual_size: input.bytes.length,
    completeness: "complete",
    executable: false,
    external_claim_trusted_without_verification: false,
  });
}

export function buildArtifactSet(input, budget) {
  if (!Array.isArray(input.nodes) || !Array.isArray(input.edges) ||
      typeof input.commitment_domain !== "string" || input.commitment_domain.length < 8 ||
      !Number.isSafeInteger(input.current_erasure_generation)) reject("ARTIFACT_SET_INPUT_INVALID");
  if (input.nodes.length > budget.max_items || input.edges.length > budget.max_edges) {
    reject("ARTIFACT_GRAPH_BUDGET_EXCEEDED");
  }
  const nodeMap = new Map();
  let totalBytes = 0;
  let metadataBytes = 0;
  for (const node of input.nodes) {
    if (nodeMap.has(node.node_id)) reject("ARTIFACT_NODE_DUPLICATE");
    if (!/^sha256:[0-9a-f]{64}$/.test(node.content_digest || "") ||
        !Number.isSafeInteger(node.size) || node.size < 0) reject("ARTIFACT_NODE_INVALID");
    totalBytes += node.size;
    metadataBytes += Buffer.byteLength(JSON.stringify({
      node_id: node.node_id,
      location_ref: node.location_ref,
      media_type: node.media_type,
      data_classification: node.data_classification,
    }), "utf8");
    if (node.erasure_generation !== input.current_erasure_generation || node.erased === true) {
      reject("ERASURE_BARRIER_REJECTED");
    }
    nodeMap.set(node.node_id, structuredClone(node));
  }
  if (totalBytes > budget.max_total_bytes || metadataBytes > budget.max_metadata_bytes) {
    reject("ARTIFACT_BYTE_BUDGET_EXCEEDED");
  }

  const outgoing = new Map([...nodeMap.keys()].map((id) => [id, []]));
  const indegree = new Map([...nodeMap.keys()].map((id) => [id, 0]));
  const edgeIds = new Set();
  for (const edge of input.edges) {
    if (edgeIds.has(edge.edge_id) || !nodeMap.has(edge.from) || !nodeMap.has(edge.to)) {
      reject("ARTIFACT_EDGE_INVALID");
    }
    edgeIds.add(edge.edge_id);
    outgoing.get(edge.from).push(edge.to);
    indegree.set(edge.to, indegree.get(edge.to) + 1);
  }

  const queue = [...indegree.entries()].filter(([,degree]) => degree === 0).map(([id]) => id).sort();
  const depth = new Map(queue.map((id) => [id, 1]));
  const order = [];
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    for (const next of outgoing.get(id).sort()) {
      depth.set(next, Math.max(depth.get(next) ?? 1, (depth.get(id) ?? 1) + 1));
      const degree = indegree.get(next) - 1;
      indegree.set(next, degree);
      if (degree === 0) {
        queue.push(next);
        queue.sort();
      }
    }
  }
  if (order.length !== nodeMap.size) reject("ARTIFACT_GRAPH_CYCLE");
  const maxDepth = Math.max(0, ...depth.values());
  if (maxDepth > budget.max_reference_depth) reject("ARTIFACT_GRAPH_DEPTH_EXCEEDED");

  const missingRequired = [...nodeMap.values()].filter((node) =>
    node.required && (!node.present || !node.verified));
  const completeness = missingRequired.length === 0 ? "complete" : "partial";
  const normalizedNodes = order.map((id) => {
    const node = nodeMap.get(id);
    return {
      node_id: node.node_id,
      content_digest: node.content_digest,
      size: node.size,
      required: Boolean(node.required),
      present: Boolean(node.present),
      verified: Boolean(node.verified),
      executable_trust: node.executable_trust || "untrusted_executable",
      erasure_generation: node.erasure_generation,
    };
  });
  const merkleCommitment = digestObject({
    domain: input.commitment_domain,
    tenant_id: input.tenant_id,
    subject_ref: input.subject_ref,
    context_key: input.context_key,
    nodes: normalizedNodes,
    edges: [...input.edges].sort((a,b) => a.edge_id.localeCompare(b.edge_id)),
  });
  return Object.freeze({
    artifact_set_id: input.artifact_set_id,
    completeness,
    missing_required_node_ids: missingRequired.map((node) => node.node_id).sort(),
    total_bytes: totalBytes,
    metadata_bytes: metadataBytes,
    max_depth: maxDepth,
    merkle_commitment: merkleCommitment,
    parser_profile_digest: input.parser_profile_digest,
    nodes_auto_executed: false,
  });
}

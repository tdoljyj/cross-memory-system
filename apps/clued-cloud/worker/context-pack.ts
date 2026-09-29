// Information Flow M0-D slice S4: Worker-side token measurement for MSCP
// packs (contract development/contracts/information-flow/M0DCloseout.v0.1.md
// sections 6.2 and 6.3). The definer Compiler is authoritative for
// authorization, retrieval, serialization, digests and manifests; the Worker
// only counts the exact pack_text with the bound tokenizer and enforces the
// policy token budget. A tokenizer that cannot be loaded or verified fails
// closed. The count lives in `measurement`, bound to pack_digest, outside the
// digested pack body.

export const TOKENIZER_TARGET = Object.freeze({
  package: "js-tiktoken",
  version: "1.0.21",
  encoding: "o200k_base",
  model_mapping: "gpt-4.1-2025-04-14",
});

// sha256 of JSON.stringify(ranks) for js-tiktoken 1.0.21 ranks/o200k_base
// (pat_str, special_tokens and bpe_ranks). The installed package files are
// also pinned by scripts/phase2-qualification/minimum-context-compiler/
// TokenizerBinding.json and verified in tests.
export const O200K_RANKS_SHA256 = "de7eb511338b0e23589a3cae2dceb8dd66c2a9fd70dbf7ea778fd9df9f175d45";

export type TokenCounter = { count(text: string): number };
export type TokenizerLoader = () => Promise<TokenCounter>;

async function sha256Hex(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function loadBoundTokenizer(): Promise<TokenCounter> {
  const [{ Tiktoken, getEncodingNameForModel }, ranksModule] = await Promise.all([
    import("js-tiktoken/lite"),
    import("js-tiktoken/ranks/o200k_base"),
  ]);
  if (getEncodingNameForModel(TOKENIZER_TARGET.model_mapping) !== TOKENIZER_TARGET.encoding) {
    throw new Error("tokenizer_model_mapping_mismatch");
  }
  const ranks = ranksModule.default;
  if (await sha256Hex(JSON.stringify(ranks)) !== O200K_RANKS_SHA256) {
    throw new Error("tokenizer_ranks_digest_mismatch");
  }
  const encoder = new Tiktoken(ranks);
  // Special-token text is counted as ordinary text, exactly as the
  // minimum-context-compiler tokenizer binding does.
  return { count: (text: string) => encoder.encode(text, [], []).length };
}

let tokenizerPromise: Promise<TokenCounter> | null = null;

export function loadTokenizer(): Promise<TokenCounter> {
  tokenizerPromise ??= loadBoundTokenizer().catch((error) => {
    tokenizerPromise = null;
    throw error;
  });
  return tokenizerPromise;
}

export type MeasuredPack = { result: unknown; httpStatus?: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function tokenizerMatches(value: unknown) {
  if (!isRecord(value)) return false;
  const expected: Record<string, string> = { ...TOKENIZER_TARGET, status: "offline_target" };
  const keys = Object.keys(value);
  return keys.length === Object.keys(expected).length && keys.every((key) => value[key] === expected[key]);
}

// Passes through anything that is not a compiled pack. For a pack, verifies
// that pack_text hashes to pack_digest and that the pack binds the target
// tokenizer, then counts pack_text and enforces pack.token_budget.
export async function measurePack(result: unknown, loader: TokenizerLoader = loadTokenizer): Promise<MeasuredPack> {
  if (!isRecord(result) || result.status !== "ok" || typeof result.pack_text !== "string") return { result };
  const pack = result.pack;
  const packDigest = result.pack_digest;
  const budget = isRecord(pack) ? pack.token_budget : undefined;
  if (!isRecord(pack) || typeof packDigest !== "string" || !Number.isSafeInteger(budget) ||
    (budget as number) < 1 || !tokenizerMatches(pack.tokenizer) ||
    await sha256Hex(result.pack_text) !== packDigest) {
    return {
      httpStatus: 502,
      result: { status: "rejected", error_code: "CONTEXT_PACK_INTEGRITY", authoritative: false,
        execution_authorization: "NOT_GRANTED", model_extraction: "NOT_EVALUATED" },
    };
  }
  let counter: TokenCounter;
  try {
    counter = await loader();
  } catch {
    console.error(JSON.stringify({ event: "context_pack_tokenizer_unavailable" }));
    return {
      httpStatus: 503,
      result: { status: "rejected", error_code: "TOKENIZER_UNAVAILABLE", authoritative: false,
        execution_authorization: "NOT_GRANTED", model_extraction: "NOT_EVALUATED" },
    };
  }
  const tokenCount = counter.count(result.pack_text);
  if (!Number.isSafeInteger(tokenCount) || tokenCount < 1) {
    return {
      httpStatus: 503,
      result: { status: "rejected", error_code: "TOKENIZER_UNAVAILABLE", authoritative: false,
        execution_authorization: "NOT_GRANTED", model_extraction: "NOT_EVALUATED" },
    };
  }
  if (tokenCount > (budget as number)) {
    // Fail closed: a pack is never truncated or summarized to fit.
    return {
      httpStatus: 422,
      result: { status: "rejected", error_code: "CONTEXT_INSUFFICIENT", reason: "token_budget_exceeded",
        token_count: tokenCount, token_budget: budget, pack_digest: packDigest, authoritative: false,
        execution_authorization: "NOT_GRANTED", model_extraction: "NOT_EVALUATED" },
    };
  }
  return {
    result: {
      ...result,
      measurement: {
        status: "measured", token_count: tokenCount, token_budget: budget, tokenizer_status: "offline_target",
        tokenizer: { ...TOKENIZER_TARGET }, counted: "pack_text", pack_digest: packDigest,
      },
    },
  };
}

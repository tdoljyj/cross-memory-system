/**
 * Some connector hosts add their own error_code when isError is true. Keep
 * Clued's canonical code under error.code as well, so that classification
 * cannot overwrite it. This runs only at the MCP boundary, after sanitization;
 * REST and the canonical database envelope retain their existing shape.
 */
export function withCanonicalMcpError(result: unknown): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const toolResult = result as Record<string, unknown>;
  if (toolResult.isError !== true) return result;

  const value = toolResult.structuredContent;
  if (!value || typeof value !== "object" || Array.isArray(value)) return result;
  const body = value as Record<string, unknown>;
  if ((body.status !== "rejected" && body.status !== "failed") ||
      typeof body.error_code !== "string" || !body.error_code ||
      Object.prototype.hasOwnProperty.call(body, "error")) return result;

  // Preserve other content blocks and metadata. Do not replace an independent
  // human-readable text block: only decorate the paired canonical JSON block.
  const content = toolResult.content;
  if (!Array.isArray(content) || !content[0] || typeof content[0] !== "object") return result;
  const first = content[0] as Record<string, unknown>;
  if (first.type !== "text" || first.text !== JSON.stringify(body)) return result;

  const envelope = {
    ...body,
    error: { code: body.error_code, category: "canonical_result", status: body.status },
  };
  return {
    ...toolResult,
    content: [{ ...first, text: JSON.stringify(envelope) }, ...content.slice(1)],
    structuredContent: envelope,
  };
}

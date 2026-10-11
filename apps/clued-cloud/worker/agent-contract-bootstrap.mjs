// ComponentVersioning.v0.2 §2.3, Task af536fcc: the MCP text travels once.
// Pure renderer shared by the Worker and the source budget check; no request state or I/O.
export const AGENT_BOOTSTRAP_BUDGET_BYTES = 76_000;

export function renderedBootstrapBytes(response) {
  return new TextEncoder().encode(JSON.stringify(response)).byteLength;
}

function sections(markdown) {
  const offsets = [0];
  let offset = 0;
  let fence = null;
  for (const line of markdown.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const visible = line.replace(/\r?\n$/, "");
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(visible);
    if (fence) {
      if (marker && marker[1][0] === fence.character && marker[1].length >= fence.length && /^\s*$/.test(marker[2])) {
        fence = null;
      }
    } else if (marker && !(marker[1][0] === "`" && marker[2].includes("`"))) {
      fence = { character: marker[1][0], length: marker[1].length };
    } else if (visible.startsWith("## ") && offset > 0) {
      offsets.push(offset);
    }
    offset += line.length;
  }
  offsets.push(markdown.length);
  return offsets;
}

function responseFor(bootstrap, contract, markdown, part, parts) {
  const url = bootstrap.lifecycle.contract.url;
  const content = [
    { type: "text", text: JSON.stringify(bootstrap) },
    { type: "text", text: markdown },
  ];
  if (parts > 1) {
    const next = part < parts
      ? `call clued_agent_bootstrap with part=${part + 1}`
      : `last part; concatenate all ${parts} parts in order`;
    content.push({ type: "text", text: `Part ${part} of ${parts} of the Clued Agent Contract; ${next}.` });
  }
  return {
    content,
    structuredContent: {
      schema_version: bootstrap.schema_version,
      kernel_version: bootstrap.kernel_version,
      components: bootstrap.components,
      lifecycle: bootstrap.lifecycle,
      agent_contract: { version: contract.version, sha256: contract.sha256, part, parts, markdown_in: "content[1]", url },
    },
    isError: false,
  };
}

function partition(bootstrap, contract) {
  const markdown = contract.markdown;
  const whole = responseFor(bootstrap, contract, markdown, 1, 1);
  if (renderedBootstrapBytes(whole) <= AGENT_BOOTSTRAP_BUDGET_BYTES) return [markdown];
  const offsets = sections(markdown);
  const count = offsets.length - 1;
  // Search partition sizes in order. Per-part JSON and hint overhead is measured exactly,
  // including UTF-8, escapes and the digit width of the final part count.
  for (let parts = 2; parts <= count; parts++) {
    const failed = new Set();
    function visit(start, part) {
      if (part > parts) return start === count ? [] : null;
      const key = `${start}:${part}`;
      if (failed.has(key)) return null;
      const remaining = parts - part;
      for (let end = count - remaining; end > start; end--) {
        const text = markdown.slice(offsets[start], offsets[end]);
        if (renderedBootstrapBytes(responseFor(bootstrap, contract, text, part, parts)) > AGENT_BOOTSTRAP_BUDGET_BYTES) continue;
        const rest = visit(end, part + 1);
        if (rest) return [text, ...rest];
      }
      failed.add(key);
      return null;
    }
    const result = visit(0, 1);
    if (result) return result;
  }
  throw new RangeError("A contract section or the bootstrap metadata exceeds the response budget.");
}

/** @param {object} bootstrap @param {{markdown:string,version:number,sha256:string}} contract @param {unknown} requestedPart */
export function renderAgentContractBootstrap(bootstrap, contract, requestedPart) {
  const pieces = partition(bootstrap, contract);
  const part = requestedPart === undefined ? 1 : requestedPart;
  if (!Number.isInteger(part) || part < 1 || part > pieces.length) {
    const error = { error: "agent_contract_part_invalid", parts: pieces.length,
      version: contract.version, sha256: contract.sha256 };
    return { content: [{ type: "text", text: JSON.stringify(error) }], structuredContent: error, isError: true };
  }
  return responseFor(bootstrap, contract, pieces[part - 1], part, pieces.length);
}

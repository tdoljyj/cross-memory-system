/** Minimal, bounded SAX tokenizer for OOXML / ODF text extraction
 * (StorageNormalUse.v0.1 §4.3, N-T3).
 *
 * - Any `<!DOCTYPE` or `<!ENTITY` (any case, anywhere in the part, including inside CDATA) is
 *   rejected with `document_invalid` before tokenizing. There is no DTD support and no entity
 *   expansion: only the five predefined entities and numeric character references are decoded;
 *   any other `&name;` is `document_invalid`.
 * - Input is bounded (default and maximum 16 MiB per part), nesting depth is bounded, and tags
 *   must balance.
 * - Events are delivered in document order to `onOpen(name, attrs, selfClosing)`,
 *   `onClose(name)` and `onText(text)`. A handler that returns `false` stops parsing early
 *   (used once an output cap is reached). Element names keep their prefix; `localName()` strips it. */

export const XML_LIMITS = Object.freeze({
  maxPartBytes: 16 * 1024 * 1024,
  maxDepth: 512,
  maxAttributes: 256,
});

export class XmlSaxError extends Error {
  constructor(detail) {
    super(`document_invalid: ${detail}`);
    this.name = "XmlSaxError";
    this.code = "document_invalid";
  }
}

const bad = (detail) => { throw new XmlSaxError(detail); };
const decoder = new TextDecoder("utf-8", { fatal: true });
const FORBIDDEN_DECLARATION = /<!\s*(?:DOCTYPE|ENTITY)/i;
const NAME = /^[A-Za-z_:À-￿][\w.\-:·À-￿]*$/;
const PREDEFINED = { lt: "<", gt: ">", amp: "&", quot: "\"", apos: "'" };

export const localName = (name) => { const at = name.indexOf(":"); return at < 0 ? name : name.slice(at + 1); };

export function decodeEntities(text) {
  if (!text.includes("&")) return text;
  return text.replace(/&([^;&\s]{0,32});?/g, (match, body) => {
    if (!match.endsWith(";")) bad("unterminated entity reference");
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      const digits = body[1] === "x" || body[1] === "X" ? /^#[xX][0-9a-fA-F]+$/ : /^#[0-9]+$/;
      if (!digits.test(body) || !Number.isFinite(code) || code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) bad("invalid character reference");
      return String.fromCodePoint(code);
    }
    if (!Object.hasOwn(PREDEFINED, body)) bad(`undeclared entity &${body};`);
    return PREDEFINED[body];
  });
}

function toText(input, maxBytes) {
  if (typeof input === "string") {
    // UTF-16 length is a lower bound on UTF-8 bytes; exact check only when near the cap.
    if (input.length > maxBytes || (input.length * 3 > maxBytes && new TextEncoder().encode(input).byteLength > maxBytes)) {
      throw Object.assign(new XmlSaxError("part too large"), { code: "archive_limit_exceeded" });
    }
    return input;
  }
  if (!(input instanceof Uint8Array)) throw new TypeError("XML input must be a string or Uint8Array");
  if (input.byteLength > maxBytes) throw Object.assign(new XmlSaxError("part too large"), { code: "archive_limit_exceeded" });
  try {
    return decoder.decode(input);
  } catch {
    return bad("not valid UTF-8");
  }
}

function parseAttributes(source, limits) {
  const attrs = {};
  let count = 0;
  const re = /\s*([^\s=/>]+)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/y;
  let at = 0;
  while (at < source.length) {
    if (/^\s*$/.test(source.slice(at))) break;
    re.lastIndex = at;
    const m = re.exec(source);
    if (!m) bad("malformed attribute");
    if (!NAME.test(m[1])) bad("invalid attribute name");
    if (Object.hasOwn(attrs, m[1])) bad("duplicate attribute");
    if (++count > limits.maxAttributes) bad("too many attributes");
    attrs[m[1]] = decodeEntities(m[2] ?? m[3]);
    at = re.lastIndex;
  }
  return attrs;
}

/** Tokenize `input` (string or UTF-8 bytes). Returns `{ stopped }`. */
export function parseXml(input, handlers = {}, { maxBytes = XML_LIMITS.maxPartBytes, maxDepth = XML_LIMITS.maxDepth } = {}) {
  if (maxBytes > XML_LIMITS.maxPartBytes) throw new RangeError("maxBytes may not exceed the contract part limit");
  const limits = { ...XML_LIMITS, maxDepth: Math.min(maxDepth, XML_LIMITS.maxDepth) };
  let xml = toText(input, maxBytes);
  if (xml.charCodeAt(0) === 0xfeff) xml = xml.slice(1);
  if (FORBIDDEN_DECLARATION.test(xml)) bad("DOCTYPE or ENTITY declaration");

  const { onOpen, onClose, onText } = handlers;
  const stack = [];
  let seenRoot = false;
  let i = 0;
  const emitText = (raw, decode) => {
    if (!raw) return true;
    if (stack.length === 0) {
      if (/\S/.test(raw)) bad("text outside the root element");
      return true;
    }
    return onText ? onText(decode ? decodeEntities(raw) : raw) !== false : true;
  };

  while (i < xml.length) {
    const lt = xml.indexOf("<", i);
    const textEnd = lt < 0 ? xml.length : lt;
    if (textEnd > i) {
      const raw = xml.slice(i, textEnd);
      if (raw.includes(">") && raw.includes("]]>")) bad("']]>' in text");
      if (!emitText(raw, true)) return { stopped: true };
    }
    if (lt < 0) break;
    i = lt;
    if (xml.startsWith("<?", i)) {
      const end = xml.indexOf("?>", i + 2);
      if (end < 0) bad("unterminated processing instruction");
      i = end + 2;
      continue;
    }
    if (xml.startsWith("<!--", i)) {
      const end = xml.indexOf("-->", i + 4);
      if (end < 0) bad("unterminated comment");
      i = end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", i)) {
      const end = xml.indexOf("]]>", i + 9);
      if (end < 0) bad("unterminated CDATA");
      if (stack.length === 0) bad("CDATA outside the root element");
      if (!emitText(xml.slice(i + 9, end), false)) return { stopped: true };
      i = end + 3;
      continue;
    }
    if (xml.startsWith("<!", i)) bad("markup declaration");
    const gt = findTagEnd(xml, i + 1);
    if (gt < 0) bad("unterminated tag");
    const body = xml.slice(i + 1, gt);
    i = gt + 1;
    if (body.startsWith("/")) {
      const name = body.slice(1).trim();
      const open = stack.pop();
      if (open !== name) bad(`mismatched </${name}>`);
      if (onClose && onClose(name) === false) return { stopped: true };
      continue;
    }
    const selfClosing = body.endsWith("/");
    const inner = selfClosing ? body.slice(0, -1) : body;
    const nameMatch = /^[^\s/>]+/.exec(inner);
    if (!nameMatch || !NAME.test(nameMatch[0])) bad("invalid element name");
    const name = nameMatch[0];
    if (stack.length === 0) {
      if (seenRoot) bad("more than one root element");
      seenRoot = true;
    }
    const attrs = parseAttributes(inner.slice(name.length), limits);
    if (!selfClosing) {
      if (stack.length >= limits.maxDepth) bad("nesting too deep");
      stack.push(name);
    }
    if (onOpen && onOpen(name, attrs, selfClosing) === false) return { stopped: true };
    if (selfClosing && onClose && onClose(name) === false) return { stopped: true };
  }
  if (stack.length) bad("unclosed element");
  if (!seenRoot) bad("no root element");
  return { stopped: false };
}

function findTagEnd(xml, from) {
  let quote = 0;
  for (let j = from; j < xml.length; j += 1) {
    const c = xml.charCodeAt(j);
    if (quote) { if (c === quote) quote = 0; continue; }
    if (c === 34 || c === 39) quote = c;
    else if (c === 62) return j;
    else if (c === 60) return -1;
  }
  return -1;
}

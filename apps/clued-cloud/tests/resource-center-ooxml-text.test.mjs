import assert from "node:assert/strict";
import test from "node:test";
import { csvField, extractOoxmlText, OOXML_TEXT_LIMITS, parseCellRef, resolvePartTarget } from "../../../kernel/host/resource-center-ooxml-text.mjs";
import { decodeEntities, parseXml, XML_LIMITS } from "../../../kernel/host/resource-center-xml-sax.mjs";
import { openZip } from "../../../kernel/host/resource-center-zip-reader.mjs";
import { buildZip } from "./resource-center-zip.fixture.mjs";

const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG = "http://schemas.openxmlformats.org/package/2006/relationships";
const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const S = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const DECL = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n";
const rels = (items) => `${DECL}<Relationships xmlns="${PKG}">${items.map(([id, type, target, mode]) =>
  `<Relationship Id="${id}" Type="${R}/${type}" Target="${target}"${mode ? ` TargetMode="${mode}"` : ""}/>`).join("")}</Relationships>`;
const rootRels = (target) => rels([["rId1", "officeDocument", target]]);
const rejectsCode = (promise, code) => assert.rejects(promise, (error) => { assert.equal(error.code, code); return true; });

function docxXml(body) {
  return `${DECL}<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>${body}</w:body></w:document>`;
}
const docx = (documentXml, extra = []) => buildZip([
  { name: "[Content_Types].xml", data: `${DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>` },
  { name: "_rels/.rels", data: rootRels("word/document.xml") },
  { name: "word/document.xml", data: documentXml },
  ...extra,
]);

async function xlsx(sheets, sharedStrings) {
  const workbook = `${DECL}<workbook xmlns="${S}" xmlns:r="${R}"><sheets>${sheets.map((s, i) =>
    `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`;
  const wbRels = rels([...sheets.map((s, i) => [`rId${i + 1}`, "worksheet", `worksheets/${s.file}`]),
    ...(sharedStrings ? [["rIdS", "sharedStrings", "sharedStrings.xml"]] : [])]);
  return buildZip([
    { name: "_rels/.rels", data: rootRels("xl/workbook.xml") },
    { name: "xl/workbook.xml", data: workbook },
    { name: "xl/_rels/workbook.xml.rels", data: wbRels },
    ...(sharedStrings ? [{ name: "xl/sharedStrings.xml", data: `${DECL}<sst xmlns="${S}">${sharedStrings}</sst>` }] : []),
    ...sheets.map((s) => ({ name: `xl/worksheets/${s.file}`, data: `${DECL}<worksheet xmlns="${S}"><sheetData>${s.rows}</sheetData></worksheet>` })),
  ]);
}

async function pptx(slides, order) {
  const presentation = `${DECL}<p:presentation xmlns:p="${P}" xmlns:r="${R}"><p:sldIdLst>${order.map((file, i) =>
    `<p:sldId id="${256 + i}" r:id="rId${file}"/>`).join("")}</p:sldIdLst></p:presentation>`;
  return buildZip([
    { name: "_rels/.rels", data: rootRels("ppt/presentation.xml") },
    { name: "ppt/presentation.xml", data: presentation },
    { name: "ppt/_rels/presentation.xml.rels", data: rels([...Object.keys(slides).map((n) => [`rId${n}`, "slide", `slides/slide${n}.xml`]),
      ["rIdX", "slide", "https://example.invalid/slide.xml", "External"]]) },
    ...Object.entries(slides).map(([n, body]) => ({ name: `ppt/slides/slide${n}.xml`,
      data: `${DECL}<p:sld xmlns:p="${P}" xmlns:a="${A}"><p:cSld><p:spTree><p:sp><p:txBody>${body}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>` })),
  ]);
}

test("limits: 256 KiB text output, 16 MiB XML part", () => {
  assert.equal(OOXML_TEXT_LIMITS.maxTextBytes, 256 * 1024);
  assert.equal(XML_LIMITS.maxPartBytes, 16 * 1024 * 1024);
});

test("docx: paragraphs, tabs, breaks, CJK, entities; deleted text and field codes skipped", async () => {
  const bytes = await docx(docxXml(
    "<w:p><w:r><w:t>第一段：你好，世界</w:t></w:r></w:p>"
    + "<w:p><w:r><w:t xml:space=\"preserve\">A </w:t><w:tab/><w:t>B &amp; &lt;C&gt; &#x4E2D;&#25991;</w:t><w:br/><w:t>line2</w:t></w:r></w:p>"
    + "<w:p><w:del><w:r><w:delText>removed</w:delText></w:r></w:del><w:r><w:instrText>PAGE</w:instrText></w:r><w:r><w:t>kept</w:t></w:r></w:p>"
    + "<w:tbl><w:tr><w:tc><w:p><w:r><w:t>cell 1</w:t></w:r></w:p></w:tc></w:tr></w:tbl>",
  ));
  const out = await extractOoxmlText(bytes, { kind: "docx" });
  assert.equal(out.untrusted_content, true);
  assert.equal(out.truncated, false);
  assert.deepEqual(out.segments.map((s) => [s.name, s.part]), [["document", "word/document.xml"]]);
  assert.equal(out.segments[0].text, "第一段：你好，世界\nA \tB & <C> 中文\nline2\nkept\ncell 1\n");
  assert.equal(out.text_bytes, new TextEncoder().encode(out.segments[0].text).byteLength);
});

test("docx: main part found through _rels/.rels even under a non-default path and prefix", async () => {
  const bytes = await buildZip([
    { name: "_rels/.rels", data: rootRels("/custom/main.xml") },
    { name: "custom/main.xml", data: `${DECL}<x:document xmlns:x="${W}"><x:body><x:p><x:r><x:t>custom prefix</x:t></x:r></x:p></x:body></x:document>` },
  ]);
  assert.equal((await extractOoxmlText(bytes, { kind: "docx" })).segments[0].text, "custom prefix\n");
});

test("docx: output is capped at maxTextBytes on a UTF-8 boundary with truncated=true", async () => {
  const para = "<w:p><w:r><w:t>汉字汉字汉字汉字汉字</w:t></w:r></w:p>";
  const out = await extractOoxmlText(await docx(docxXml(para.repeat(100))), { kind: "docx", maxTextBytes: 40 });
  assert.equal(out.truncated, true);
  assert.ok(out.text_bytes <= 40);
  assert.equal(out.segments[0].text, "汉字汉字汉字汉字汉字\n汉字汉");
  assert.equal(out.text_bytes, 40);
  const big = await extractOoxmlText(await docx(docxXml(`<w:p><w:r><w:t>${"x".repeat(300 * 1024)}</w:t></w:r></w:p>`)), { kind: "docx" });
  assert.equal(big.truncated, true);
  assert.equal(big.text_bytes, 256 * 1024);
  await assert.rejects(extractOoxmlText(await docx(docxXml("")), { kind: "docx", maxTextBytes: 256 * 1024 + 1 }), RangeError);
});

test("DOCTYPE, ENTITY and billion laughs are document_invalid with no expansion", async () => {
  const laughs = `${DECL}<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">`
    + "<!ENTITY lol3 \"&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;\">]>"
    + `<w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t>&lol3;</w:t></w:r></w:p></w:body></w:document>`;
  await rejectsCode(extractOoxmlText(await docx(laughs), { kind: "docx" }), "document_invalid");
  const xxe = `${DECL}<!DOCTYPE d [<!ENTITY x SYSTEM "file:///etc/passwd">]><w:document xmlns:w="${W}"><w:body/></w:document>`;
  await rejectsCode(extractOoxmlText(await docx(xxe), { kind: "docx" }), "document_invalid");
  await rejectsCode(extractOoxmlText(await docx(`${DECL}<!doctype html><w:document xmlns:w="${W}"/>`), { kind: "docx" }), "document_invalid");
  // An undeclared entity is not expanded either.
  await rejectsCode(extractOoxmlText(await docx(docxXml("<w:p><w:r><w:t>&nbsp;</w:t></w:r></w:p>")), { kind: "docx" }), "document_invalid");
  // A DOCTYPE in a relationship part is rejected too.
  await rejectsCode(extractOoxmlText(await buildZip([
    { name: "_rels/.rels", data: `${DECL}<!DOCTYPE r><Relationships xmlns="${PKG}"/>` },
    { name: "word/document.xml", data: docxXml("") },
  ]), { kind: "docx" }), "document_invalid");
});

test("malformed XML is document_invalid", async () => {
  for (const body of ["<w:p><w:t>open</w:p>", "<w:p><w:r><w:t>a</w:r></w:t></w:p>", "<w:p attr=unquoted/>", "<w:p a=\"1\" a=\"2\"/>", "<w:p>&amp</w:p>"]) {
    await rejectsCode(extractOoxmlText(await docx(docxXml(body)), { kind: "docx" }), "document_invalid");
  }
  await rejectsCode(extractOoxmlText(await docx(new Uint8Array([0x3c, 0x61, 0x3e, 0xff, 0x3c, 0x2f, 0x61, 0x3e])), { kind: "docx" }), "document_invalid");
});

test("a missing main part is document_invalid; a zip bomb part is archive_limit_exceeded", async () => {
  await rejectsCode(extractOoxmlText(await buildZip([{ name: "other.xml", data: "<a/>" }]), { kind: "docx" }), "document_invalid");
  const huge = `${DECL}<w:document xmlns:w="${W}"><w:body>${" ".repeat(17 * 1024 * 1024)}</w:body></w:document>`;
  await rejectsCode(extractOoxmlText(await docx(huge), { kind: "docx" }), "archive_limit_exceeded");
});

test("xlsx: sheets in workbook order as CSV, shared strings, cell refs with gaps, inline strings, booleans, quoting", async () => {
  const shared = "<si><t>名前</t></si><si><t>Price, USD</t></si><si><r><t>rich </t></r><r><t>text</t></r><rPh><t>ルビ</t></rPh></si><si><t>say \"hi\"</t></si>";
  const bytes = await xlsx([
    { name: "数据", file: "sheet2.xml", rows:
      "<row r=\"1\"><c r=\"A1\" t=\"s\"><v>0</v></c><c r=\"C1\" t=\"s\"><v>1</v></c></row>"
      + "<row r=\"2\"><c r=\"A2\" t=\"s\"><v>2</v></c><c r=\"B2\"><v>3.5</v></c><c r=\"C2\" t=\"b\"><v>1</v></c></row>"
      + "<row r=\"4\"><c r=\"B4\" t=\"inlineStr\"><is><t>多行\n文本</t></is></c><c r=\"D4\" t=\"s\"><v>3</v></c><c r=\"E4\" t=\"e\"><v>#DIV/0!</v></c></row>" },
    { name: "Second", file: "sheet1.xml", rows: "<row><c><v>1</v></c><c><f>A1+1</f><v>2</v></c></row><row><c t=\"str\"><v>formula text</v></c></row>" },
  ], shared);
  const out = await extractOoxmlText(bytes, { kind: "xlsx" });
  assert.deepEqual(out.segments.map((s) => [s.name, s.part]), [["数据", "xl/worksheets/sheet2.xml"], ["Second", "xl/worksheets/sheet1.xml"]]);
  assert.equal(out.segments[0].text, "名前,,\"Price, USD\"\nrich text,3.5,TRUE\n\n,\"多行\n文本\",,\"say \"\"hi\"\"\",#DIV/0!\n");
  assert.equal(out.segments[1].text, "1,2\nformula text\n");
  const one = await extractOoxmlText(bytes, { kind: "xlsx", segment: "Second" });
  assert.deepEqual(one.segments.map((s) => s.name), ["Second"]);
  await rejectsCode(extractOoxmlText(bytes, { kind: "xlsx", segment: "nope" }), "entry_not_found");
});

test("xlsx: remaining sheets are skipped once the cap is hit and truncated is set", async () => {
  const row = (r) => `<row r="${r}"><c r="A${r}"><v>${r}</v></c></row>`;
  const bytes = await xlsx([
    { name: "A", file: "a.xml", rows: Array.from({ length: 50 }, (_, i) => row(i + 1)).join("") },
    { name: "B", file: "b.xml", rows: row(1) },
  ]);
  const out = await extractOoxmlText(bytes, { kind: "xlsx", maxTextBytes: 20 });
  assert.equal(out.truncated, true);
  assert.deepEqual(out.segments.map((s) => s.name), ["A"]);
  assert.equal(out.segments[0].text, "1\n2\n3\n4\n5\n6\n7\n8\n9\n10");
  const exact = await extractOoxmlText(await xlsx([{ name: "A", file: "a.xml", rows: row(1) }, { name: "B", file: "b.xml", rows: row(1) }]), { kind: "xlsx", maxTextBytes: 2 });
  assert.equal(exact.truncated, true);
  assert.deepEqual(exact.segments.map((s) => s.text), ["1\n"]);
});

test("xlsx: far-away cell references are bounded by the output cap", async () => {
  const bytes = await xlsx([{ name: "Far", file: "far.xml", rows: "<row r=\"1048576\"><c r=\"XFD1048576\"><v>1</v></c></row>" }]);
  const out = await extractOoxmlText(bytes, { kind: "xlsx" });
  assert.equal(out.truncated, true);
  assert.equal(out.text_bytes, 256 * 1024);
  await rejectsCode(extractOoxmlText(await xlsx([{ name: "X", file: "x.xml", rows: "<row r=\"1\"><c r=\"XFE1\"><v>1</v></c></row>" }]), { kind: "xlsx" }), "document_invalid");
});

test("pptx: slides follow sldIdLst order, not file names; external targets are ignored", async () => {
  const bytes = await pptx({
    1: "<a:p><a:r><a:t>Slide file one</a:t></a:r></a:p>",
    2: "<a:p><a:r><a:t>标题幻灯片</a:t></a:r><a:br/><a:r><a:t>副标题</a:t></a:r></a:p><a:p><a:r><a:t>second para</a:t></a:r></a:p>",
  }, ["2", "1", "X"]);
  const out = await extractOoxmlText(bytes, { kind: "pptx" });
  assert.deepEqual(out.segments, [
    { name: "Slide 1", part: "ppt/slides/slide2.xml", text: "标题幻灯片\n副标题\nsecond para\n" },
    { name: "Slide 2", part: "ppt/slides/slide1.xml", text: "Slide file one\n" },
  ]);
});

test("extraction reads through a range-mode reader and respects its budget", async () => {
  const bytes = await docx(docxXml("<w:p><w:r><w:t>range docx</w:t></w:r></w:p>"));
  const zip = await openZip({ size: bytes.byteLength, readRange: async (o, l) => bytes.slice(o, o + l) });
  assert.equal((await extractOoxmlText(zip, { kind: "docx" })).segments[0].text, "range docx\n");
  await assert.rejects(extractOoxmlText(zip, { kind: "odt" }), TypeError);
});

test("relationship targets resolve inside the package only", () => {
  assert.equal(resolvePartTarget("xl/workbook.xml", "worksheets/sheet1.xml"), "xl/worksheets/sheet1.xml");
  assert.equal(resolvePartTarget("xl/workbook.xml", "/xl/sharedStrings.xml"), "xl/sharedStrings.xml");
  assert.equal(resolvePartTarget("ppt/slides/slide1.xml", "../media/a.png"), "ppt/media/a.png");
  assert.equal(resolvePartTarget("word/document.xml", "../../../etc/passwd"), null);
  assert.equal(resolvePartTarget("word/document.xml", "https://example.invalid/x"), null);
  assert.equal(resolvePartTarget("word/document.xml", "file:///etc/passwd"), null);
});

test("helpers: cell refs, CSV quoting, entity decoding, SAX stop and bounds", () => {
  assert.deepEqual(parseCellRef("A1"), { col: 1, row: 1 });
  assert.deepEqual(parseCellRef("$AA$10"), { col: 27, row: 10 });
  assert.equal(parseCellRef("1A"), null);
  assert.equal(csvField("plain"), "plain");
  assert.equal(csvField("a,b"), "\"a,b\"");
  assert.equal(decodeEntities("&#128512;&apos;&quot;"), "😀'\"");
  assert.throws(() => decodeEntities("&#0;"), { code: "document_invalid" });
  const seen = [];
  const result = parseXml("<r><a>1</a><b>2</b><c>3</c></r>", { onText: (t) => { seen.push(t); return seen.length < 2; } });
  assert.deepEqual(seen, ["1", "2"]);
  assert.equal(result.stopped, true);
  assert.throws(() => parseXml(`${"<a>".repeat(600)}${"</a>".repeat(600)}`), { code: "document_invalid" });
  assert.throws(() => parseXml("<a/><b/>"), { code: "document_invalid" });
  assert.throws(() => parseXml("text<a/>"), { code: "document_invalid" });
  assert.throws(() => parseXml("<a><![CDATA[<!DOCTYPE x>]]></a>"), { code: "document_invalid" });
  assert.throws(() => parseXml("x".repeat(100), {}, { maxBytes: 50 }), { code: "archive_limit_exceeded" });
  assert.throws(() => parseXml("<a/>", {}, { maxBytes: 17 * 1024 * 1024 }), RangeError);
  const cdata = [];
  parseXml("<a><![CDATA[x < y & z]]><!-- c --><?pi x?></a>", { onText: (t) => { cdata.push(t); } });
  assert.deepEqual(cdata, ["x < y & z"]);
});

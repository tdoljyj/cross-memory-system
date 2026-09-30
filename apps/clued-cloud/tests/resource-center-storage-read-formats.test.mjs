import assert from "node:assert/strict";
import test from "node:test";
import { classifyFormat, extractOfficeText, imageInfo, StorageFormatError, EXTRACT_TEXT_MAX } from "../worker/storage-read-formats.ts";
import { docxOf, gifOf, jpegOf, pngOf, pptxOf, webpOf, xlsxOf } from "./resource-center-storage-formats.fixture.mjs";
import { buildZip } from "./resource-center-zip.fixture.mjs";

// StorageNormalUse.v0.1 N1b (§4): pure format helpers of clued_storage_read.

test("classifyFormat: Drive mimeType first, extension only for generic types", () => {
  const cases = [
    ["text/plain", "a.bin", "text"], ["application/json", "x", "text"],
    ["application/vnd.google-apps.folder", "f", "folder"], ["application/vnd.google-apps.document", "d", "google_doc"],
    ["application/vnd.google-apps.spreadsheet", "s", "google_sheet"], ["application/vnd.google-apps.presentation", "p", "google_slides"],
    ["application/vnd.google-apps.form", "f", "google_native"],
    ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "a", "docx"],
    ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "a", "xlsx"],
    ["application/vnd.openxmlformats-officedocument.presentationml.presentation", "a", "pptx"],
    ["application/pdf", "a", "pdf"], ["image/png", "a", "png"], ["image/jpeg", "a", "jpeg"], ["image/gif", "a", "gif"], ["image/webp", "a", "webp"],
    ["image/heic", "a", "image_other"], ["application/zip", "a", "zip"], ["application/x-7z-compressed", "a", "archive"],
    ["video/mp4", "a", "video"], ["audio/mpeg", "a", "audio"], ["application/msword", "a", "legacy_office"],
    ["application/vnd.oasis.opendocument.text", "a", "odf"],
    ["application/octet-stream", "Report.DOCX", "docx"], ["application/octet-stream", "scan.pdf", "pdf"],
    ["application/octet-stream", "photo.JPG", "jpeg"], ["application/octet-stream", "noext", "binary"],
    // A specific declared type is never overridden by the name.
    ["application/x-custom", "fake.docx", "binary"], ["image/png", "fake.docx", "png"],
  ];
  for (const [mime, name, expected] of cases) assert.equal(classifyFormat(mime, name), expected, `${mime} ${name}`);
});

test("imageInfo: magic and pixel size for png, jpeg, gif and three webp variants; anything else is null", () => {
  assert.deepEqual(imageInfo(pngOf(640, 480)), { format: "png", mime_type: "image/png", width: 640, height: 480 });
  assert.deepEqual(imageInfo(jpegOf(1024, 768)), { format: "jpeg", mime_type: "image/jpeg", width: 1024, height: 768 });
  assert.deepEqual(imageInfo(gifOf(32, 16)), { format: "gif", mime_type: "image/gif", width: 32, height: 16 });
  for (const variant of ["VP8X", "VP8L", "VP8 "])
    assert.deepEqual(imageInfo(webpOf(300, 200, variant)), { format: "webp", mime_type: "image/webp", width: 300, height: 200 }, variant);
  assert.equal(imageInfo(new TextEncoder().encode("not an image at all, just text")), null);
  assert.equal(imageInfo(pngOf(0, 10)), null, "zero width");
  assert.equal(imageInfo(pngOf(10, 10).subarray(0, 20)), null, "truncated header");
  assert.equal(imageInfo(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 4, 0, 0])), null, "jpeg without a frame header");
  assert.equal(imageInfo(new Uint8Array([0xff, 0xd8, 0x00, 0x00, 0, 0])), null, "jpeg with a broken marker");
});

test("extractOfficeText: docx, xlsx and pptx become one text; truncation is prefix-stable and never complete", async () => {
  const docx = await docxOf(["第一段 first", "second & <third>"]);
  assert.deepEqual(await extractOfficeText({ bytes: docx }, "docx", 1024), { text: "第一段 first\nsecond & <third>\n", complete: true });
  const xlsx = await xlsxOf([{ name: "Plan", rows: [["a", "b,c"], ["1", "2"]] }, { name: "二", rows: [["x"]] }]);
  const sheets = await extractOfficeText({ bytes: xlsx }, "xlsx", 1024);
  assert.equal(sheets.text, "# Sheet: Plan\na,\"b,c\"\n1,2\n\n# Sheet: 二\nx\n"); assert.equal(sheets.complete, true);
  const pptx = await pptxOf([["Title"], ["Point one", "Point two"]]);
  assert.equal((await extractOfficeText({ bytes: pptx }, "pptx", 1024)).text, "# Slide 1\nTitle\n\n# Slide 2\nPoint one\nPoint two\n");
  // Segment text is 14 bytes (headers are not counted against the cap).
  for (const cap of [1, 5, 12, 13]) {
    const part = await extractOfficeText({ bytes: xlsx }, "xlsx", cap);
    assert.equal(part.complete, false, `cap ${cap}`);
    assert.ok(sheets.text.startsWith(part.text), `cap ${cap}: a smaller budget yields a prefix`);
  }
  assert.equal(EXTRACT_TEXT_MAX, 8 * 1024 * 1024);
});

test("extractOfficeText: damaged, DOCTYPE and oversized inputs map to fixed codes", async () => {
  const code = async (source, kind = "docx") => {
    try { await extractOfficeText(source, kind, 1024); return "resolved"; }
    catch (error) { assert.ok(error instanceof StorageFormatError); return error.code; }
  };
  assert.equal(await code({ bytes: new TextEncoder().encode("this is not a zip archive, only plain text......") }), "document_invalid");
  assert.equal(await code({ bytes: await docxOf([], { documentXml: "<!DOCTYPE x [<!ENTITY a \"b\">]><w:document/>" }) }), "document_invalid");
  assert.equal(await code({ bytes: await buildZip([{ name: "other.txt", data: "x" }]) }), "document_invalid", "no main part");
  assert.equal(await code({ bytes: new Uint8Array(10 * 1024 * 1024 + 1) }), "archive_limit_exceeded", "in-memory mode above 10 MB");
  // The caller's own failures (budget, provider) pass through unchanged.
  const bytes = await docxOf(["x"]);
  assert.equal(await code({ size: bytes.length, readRange: async () => { throw new StorageFormatError("binary_too_large"); } }), "binary_too_large");
});

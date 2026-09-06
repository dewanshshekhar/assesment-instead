import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import { PDFDocument, PDFName, PDFNumber } from "pdf-lib";
import { importAcroForm } from "../src/import.ts";
import { lint } from "../src/lint.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(
  readFileSync(resolvePath(HERE, "../../spec/annotation-template.schema.json"), "utf8"),
);

/** A stand-in for an official fillable form: two pages, a comb, a checkbox. */
async function buildFillablePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setCreationDate(new Date(0));
  doc.setModificationDate(new Date(0));

  const page1 = doc.addPage([612, 792]);
  const page2 = doc.addPage([612, 792]);
  const form = doc.getForm();

  form.createTextField("Page1[0].name[0]").addToPage(page1, { x: 36, y: 700, width: 200, height: 16 });

  const ssn = form.createTextField("Page1[0].SSN[0]");
  ssn.addToPage(page1, { x: 432, y: 700, width: 144, height: 16 });
  ssn.acroField.dict.set(PDFName.of("Ff"), PDFNumber.of(1 << 24)); // comb flag
  ssn.acroField.dict.set(PDFName.of("MaxLen"), PDFNumber.of(9));

  form.createCheckBox("Page1[0].box[0]").addToPage(page1, { x: 40, y: 650, width: 10, height: 10 });
  form.createTextField("Page2[0].note[0]").addToPage(page2, { x: 100, y: 300, width: 120, height: 14 });

  return doc.save();
}

const options = {
  templateId: "us.test.acroform.2024",
  title: "AcroForm import",
  taxYear: 2024,
  revision: "test-1",
  filename: "acroform-sample.pdf",
};

test("imports every widget and records the page geometry", async () => {
  const { template, skipped } = await importAcroForm(await buildFillablePdf(), options);

  assert.deepEqual(skipped, []);
  assert.equal(template.entries.length, 4);
  assert.equal(template.template.source.pageCount, 2);
  assert.deepEqual(template.template.geometry.pages, [
    { width: 612, height: 792 },
    { width: 612, height: 792 },
  ]);
});

test("flips AcroForm rectangles into top-left space exactly once", async () => {
  const { template } = await importAcroForm(await buildFillablePdf(), options);
  const field = template.entries.find((e) => e.id.includes("name")) as any;

  // Placed at PDF y=700 with height 16 on a 792pt page, so the top edge is
  // 792 - 700 - 16 = 76. pdf-lib insets the widget by its 0.5pt border.
  assert.ok(Math.abs(field.rect[1] - 76) <= 0.5, `top edge was ${field.rect[1]}`);
  assert.ok(Math.abs(field.rect[0] - 36) <= 0.5, `left edge was ${field.rect[0]}`);
});

test("assigns each widget to the page it actually sits on", async () => {
  const { template } = await importAcroForm(await buildFillablePdf(), options);
  const onPage2 = template.entries.find((e) => e.id.includes("note")) as any;

  assert.equal(onPage2.page, 1);
  assert.ok(Math.abs(onPage2.rect[1] - 478) <= 0.5, `top edge was ${onPage2.rect[1]}`);
});

test("recognises comb and checkbox fields from the PDF itself", async () => {
  const { template } = await importAcroForm(await buildFillablePdf(), options);

  const ssn = template.entries.find((e) => e.id.includes("SSN")) as any;
  assert.equal(ssn.type, "comb");
  assert.deepEqual(ssn.comb, { cells: 9 });

  const box = template.entries.find((e) => e.id.includes("box")) as any;
  assert.equal(box.type, "checkbox");
});

test("the draft is schema-valid, so it can be linted straight away", async () => {
  const { template } = await importAcroForm(await buildFillablePdf(), options);
  const codes = lint(template, { schema }).map((d) => d.code);
  assert.ok(!codes.includes("schema/invalid"), `unexpected: ${codes.join(", ")}`);
});

test("leaves every binding as an explicit TODO", async () => {
  const { template } = await importAcroForm(await buildFillablePdf(), options);
  for (const entry of template.entries) {
    assert.match((entry as any).value.ref, /^\$\.TODO\./);
  }
});

// ---------------------------------------------------------------------------
// The official 2025 Form 1040 in forms/, which arrived with its AcroForm
// stripped by a browser's print-to-PDF. Everything below is a regression test
// against a real, imperfect file rather than a synthetic one.
// ---------------------------------------------------------------------------

const officialForm = async () =>
  new Uint8Array(await readFile(resolvePath(HERE, "../../forms/f1040-2025.pdf")));

const officialOptions = {
  templateId: "us.irs.f1040.2025",
  title: "Form 1040 (2025)",
  taxYear: 2025,
  revision: "2025",
  filename: "f1040-2025.pdf",
};

test("recovers geometry from a form whose AcroForm was stripped", async () => {
  const { template, strategy } = await importAcroForm(await officialForm(), officialOptions);

  assert.equal(strategy, "widgets", "the catalog has no AcroForm, so recovery must kick in");
  assert.equal(template.entries.length, 199);
  assert.equal(template.template.geometry.pages.length, 2);
  assert.ok(template.entries.some((e) => e.page === 1), "page 2 fields must be attributed correctly");
});

test("every recovered field has a usable, in-bounds rectangle", async () => {
  const { template } = await importAcroForm(await officialForm(), officialOptions);

  for (const entry of template.entries) {
    const [x, y, w, h] = (entry as any).rect;
    const page = template.template.geometry.pages[entry.page];
    assert.ok(w > 0 && h > 0, `${entry.id} has a degenerate rect`);
    assert.ok(x >= 0 && y >= 0 && x + w <= page.width && y + h <= page.height, `${entry.id} is off the page`);
  }
});

test("radio options that share a field name are still given distinct ids", async () => {
  const { template } = await importAcroForm(await officialForm(), officialOptions);

  const ids = template.entries.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, "an imported draft must never contain duplicate ids");

  // Filing status is one radio group of five options, and two pairs of its
  // widgets share a /T; only the appearance state tells them apart.
  const filingStatus = template.entries.filter((e) => e.label?.startsWith("c1_8["));
  assert.equal(filingStatus.length, 5);
  assert.deepEqual(
    filingStatus.map((e) => e.id).sort(),
    ["c1_8_0_.1", "c1_8_0_.4", "c1_8_1_.2", "c1_8_1_.5", "c1_8_2_.3"],
  );
});

test("comb fields are recognised through an inherited flag", async () => {
  const { template } = await importAcroForm(await officialForm(), officialOptions);
  const combs = template.entries.filter((e) => (e as any).type === "comb");

  // Taxpayer SSN, spouse SSN and four dependent SSNs on page 1.
  assert.ok(combs.length >= 6, `expected at least 6 comb fields, found ${combs.length}`);
  for (const comb of combs) assert.ok((comb as any).comb.cells > 0);
});

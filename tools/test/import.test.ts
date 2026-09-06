import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

/**
 * Bootstraps a draft template from a fillable PDF's AcroForm.
 *
 * Most official IRS PDFs ship with named form fields that already carry the
 * exact rectangle of every box. Reading them turns "annotate this form by
 * hand" into "review a generated draft", which is the difference between a
 * day of measuring and an hour of checking.
 *
 * The output is a draft: field ids come from the PDF's own naming, which is
 * rarely the naming you want, and every `value.ref` is left as a TODO for a
 * human to bind.
 */

import { PDFDocument, PDFName, PDFNumber, PDFCheckBox, PDFTextField } from "pdf-lib";
import type { AnnotationTemplate, Entry, FieldType } from "../../spec/types.ts";
import { sha256 } from "./render.ts";

/** Bit 25 of the field flags marks a text field as combed. */
const COMB_FLAG = 1 << 24;

export interface ImportOptions {
  templateId: string;
  title: string;
  taxYear: number;
  revision: string;
  filename: string;
  url?: string;
}

export async function importAcroForm(
  pdfBytes: Uint8Array,
  options: ImportOptions,
): Promise<{ template: AnnotationTemplate; skipped: string[] }> {
  const doc = await PDFDocument.load(pdfBytes);
  const pages = doc.getPages();
  const pageIndexByRef = new Map<string, number>();

  pages.forEach((page, index) => {
    const annots = page.node.Annots();
    if (!annots) return;
    for (let i = 0; i < annots.size(); i += 1) {
      pageIndexByRef.set(String(annots.get(i)), index);
    }
  });

  const entries: Entry[] = [];
  const skipped: string[] = [];

  for (const field of doc.getForm().getFields()) {
    const name = field.getName();
    const widgets = field.acroField.getWidgets();

    widgets.forEach((widget, widgetIndex) => {
      const ref = field.acroField.dict.context
        .getObjectRef(widget.dict)
        ?.toString();
      const page = ref !== undefined ? pageIndexByRef.get(ref) : undefined;

      if (page === undefined) {
        skipped.push(`${name}: could not determine which page the widget belongs to`);
        return;
      }

      const box = widget.getRectangle();
      const pageHeight = pages[page].getHeight();

      const id = sanitise(widgets.length > 1 ? `${name}.${widgetIndex}` : name);
      const type = typeOf(field);
      const comb = type === "comb" ? combOf(field) : undefined;

      entries.push({
        kind: "field",
        id,
        label: name,
        page,
        type,
        // AcroForm rectangles are in bottom-left PDF space; the spec is
        // top-left, so the y axis is flipped exactly once, here.
        rect: [
          round2(box.x),
          round2(pageHeight - box.y - box.height),
          round2(box.width),
          round2(box.height),
        ],
        ...(comb ? { comb } : {}),
        value: { ref: `$.TODO.${id}` },
        style: type === "checkbox" ? { glyph: "X", align: "center" } : { align: "left" },
      } as Entry);
    });
  }

  const template: AnnotationTemplate = {
    specVersion: "1.0.0",
    template: {
      id: options.templateId,
      title: options.title,
      taxYear: options.taxYear,
      revision: options.revision,
      source: {
        filename: options.filename,
        sha256: sha256(pdfBytes),
        pageCount: pages.length,
        ...(options.url ? { url: options.url } : {}),
      },
      geometry: {
        unit: "pt",
        origin: "top-left",
        pages: pages.map((p) => ({ width: round2(p.getWidth()), height: round2(p.getHeight()) })),
      },
    },
    entries,
  };

  return { template, skipped };
}

function typeOf(field: unknown): FieldType {
  if (field instanceof PDFCheckBox) return "checkbox";
  if (field instanceof PDFTextField) {
    const flags = numberOf(field, "Ff");
    if (flags !== undefined && (flags & COMB_FLAG) !== 0) return "comb";
    return "text";
  }
  return "text";
}

function combOf(field: unknown): { cells: number } | undefined {
  const maxLen = numberOf(field, "MaxLen");
  return maxLen && maxLen > 0 ? { cells: maxLen } : undefined;
}

function numberOf(field: any, key: string): number | undefined {
  try {
    const raw = field.acroField.dict.lookup(PDFName.of(key));
    return raw instanceof PDFNumber ? raw.asNumber() : undefined;
  } catch {
    return undefined;
  }
}

function sanitise(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[^A-Za-z0-9]+/, "");
  return cleaned.length > 0 ? cleaned : "field";
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

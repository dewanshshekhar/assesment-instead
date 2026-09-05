/**
 * Bootstraps a draft template from a fillable PDF.
 *
 * Official IRS PDFs ship with named form fields that already carry the exact
 * rectangle of every box. Reading them turns "annotate this form by hand"
 * into "review a generated draft".
 *
 * Two strategies, tried in order:
 *
 *   acroform  The catalog's AcroForm is intact. This is the normal case.
 *
 *   widgets   The AcroForm entry is gone but the widget annotations survive.
 *             Copies of official forms that have been through a browser's
 *             print-to-PDF arrive like this: the catalog entry and the pages'
 *             /Annots arrays are dropped, leaving the widget dictionaries
 *             orphaned but intact, each still naming its page through /P.
 *             The geometry is fully recoverable, so recover it rather than
 *             making someone measure 199 boxes by hand.
 *
 * Either way the output is a draft: field ids come from the PDF's own naming,
 * which is rarely the naming you want, and every `value.ref` is a TODO.
 */

import {
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFDict,
  PDFArray,
  PDFHexString,
  PDFString,
  PDFRef,
} from "pdf-lib";
import type { AnnotationTemplate, Entry, FieldType } from "../../spec/types.ts";
import { sha256 } from "./render.ts";

/** Text field flags: bit 25 marks a comb. */
const COMB_FLAG = 1 << 24;
/** Button flags: bit 16 marks a radio, bit 17 a pushbutton. */
const RADIO_FLAG = 1 << 15;
const PUSHBUTTON_FLAG = 1 << 16;

export type ImportStrategy = "acroform" | "widgets";

export interface ImportOptions {
  templateId: string;
  title: string;
  taxYear: number;
  revision: string;
  filename: string;
  url?: string;
}

export interface ImportResult {
  template: AnnotationTemplate;
  strategy: ImportStrategy;
  skipped: string[];
}

interface Widget {
  name: string;
  page: number;
  /** PDF user space: [x1, y1, x2, y2], bottom-left origin. */
  rect: [number, number, number, number];
  type: FieldType;
  comb?: { cells: number };
  /**
   * For a radio kid, the appearance state that means "this option is
   * selected". It, not the field name, is what identifies the option.
   */
  onState?: string;
}

export async function importAcroForm(
  pdfBytes: Uint8Array,
  options: ImportOptions,
): Promise<ImportResult> {
  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const pages = doc.getPages();
  const skipped: string[] = [];

  let strategy: ImportStrategy = "acroform";
  let widgets = collectFromAcroForm(doc, skipped);

  if (widgets.length === 0) {
    const recovered = collectFromOrphanedWidgets(doc, skipped);
    if (recovered.length > 0) {
      strategy = "widgets";
      widgets = recovered;
    }
  }

  // Draft in reading order, so a human can review it against the paper.
  widgets.sort((a, b) => a.page - b.page || b.rect[3] - a.rect[3] || a.rect[0] - b.rect[0]);

  const ids = uniqueIds(widgets, skipped);

  const entries: Entry[] = widgets.map((widget, index) => {
    const pageHeight = pages[widget.page].getHeight();
    const [x1, y1, x2, y2] = widget.rect;
    const id = ids[index];

    return {
      kind: "field",
      id,
      label: widget.name,
      page: widget.page,
      type: widget.type,
      // PDF rectangles are bottom-left; the spec is top-left, so the y axis
      // is flipped exactly once, here.
      rect: [round2(x1), round2(pageHeight - y2), round2(x2 - x1), round2(y2 - y1)],
      ...(widget.comb ? { comb: widget.comb } : {}),
      value: { ref: `$.TODO.${id}` },
      style: widget.type === "checkbox" ? { glyph: "X", align: "center" } : { align: "left" },
    } as Entry;
  });

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

  return { template, strategy, skipped };
}

// ---------------------------------------------------------------------------
// Strategy 1: an intact AcroForm
// ---------------------------------------------------------------------------

function collectFromAcroForm(doc: PDFDocument, skipped: string[]): Widget[] {
  if (!doc.catalog.get(PDFName.of("AcroForm"))) return [];

  const pageIndex = pageIndexByRef(doc);
  const out: Widget[] = [];

  for (const field of doc.getForm().getFields()) {
    const name = field.getName();
    const dict = field.acroField.dict;
    const widgets = field.acroField.getWidgets();

    widgets.forEach((widget, i) => {
      const ref = doc.context.getObjectRef(widget.dict)?.toString();
      const page = ref !== undefined ? pageIndex.get(ref) : undefined;
      if (page === undefined) {
        skipped.push(`${name}: could not determine which page the widget belongs to`);
        return;
      }

      const box = widget.getRectangle();
      out.push({
        name: widgets.length > 1 ? `${name}.${i}` : name,
        page,
        rect: [box.x, box.y, box.x + box.width, box.y + box.height],
        ...classify(dict, doc),
      });
    });
  }
  return out;
}

function pageIndexByRef(doc: PDFDocument): Map<string, number> {
  const index = new Map<string, number>();
  doc.getPages().forEach((page, i) => {
    const annots = page.node.Annots();
    if (!annots) return;
    for (let k = 0; k < annots.size(); k += 1) index.set(String(annots.get(k)), i);
  });
  return index;
}

// ---------------------------------------------------------------------------
// Strategy 2: orphaned widget annotations
// ---------------------------------------------------------------------------

function collectFromOrphanedWidgets(doc: PDFDocument, skipped: string[]): Widget[] {
  const pageByRef = new Map<string, number>();
  doc.getPages().forEach((page, i) => {
    const ref = doc.context.getObjectRef(page.node)?.toString();
    if (ref) pageByRef.set(ref, i);
  });

  const out: Widget[] = [];
  let anonymous = 0;

  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFDict)) continue;
    if (String(object.get(PDFName.of("Subtype"))) !== "/Widget") continue;

    const rect = numbers(doc, object.get(PDFName.of("Rect")));
    if (!rect || rect.length !== 4) {
      skipped.push("a widget annotation has no usable /Rect");
      continue;
    }

    const pageRef = object.get(PDFName.of("P"));
    const page = pageRef ? pageByRef.get(String(pageRef)) : undefined;
    if (page === undefined) {
      skipped.push(`${fieldName(object) ?? "a widget"}: /P does not name a page in this document`);
      continue;
    }

    anonymous += 1;
    const [x1, y1, x2, y2] = rect;
    out.push({
      name: fieldName(object) ?? `field_${anonymous}`,
      page,
      // A /Rect is not required to be normalised.
      rect: [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)],
      ...classify(object, doc),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Shared inspection
// ---------------------------------------------------------------------------

/** Resolves an indirect reference; leaves a direct object alone. */
function deref(doc: PDFDocument, value: unknown): unknown {
  return value instanceof PDFRef ? doc.context.lookup(value) : value;
}

/**
 * Walks /Parent so that an inherited /FT, /Ff or /MaxLen is still found.
 * IRS forms nest widgets under a shared parent field, so the type and flags
 * are frequently one level up from the annotation itself.
 */
function inherited(dict: PDFDict, doc: PDFDocument, key: string): unknown {
  let cursor: PDFDict | undefined = dict;

  for (let depth = 0; cursor && depth < 8; depth += 1) {
    const value = cursor.get(PDFName.of(key));
    if (value !== undefined) return deref(doc, value);

    const parent = deref(doc, cursor.get(PDFName.of("Parent")));
    cursor = parent instanceof PDFDict ? parent : undefined;
  }
  return undefined;
}

function classify(
  dict: PDFDict,
  doc: PDFDocument,
): { type: FieldType; comb?: { cells: number }; onState?: string } {
  const ft = String(inherited(dict, doc, "FT") ?? "");
  const flags = asNumber(inherited(dict, doc, "Ff")) ?? 0;

  if (ft === "/Btn") {
    // A pushbutton triggers an action and holds no value, so it is not a
    // field a template can print into.
    if ((flags & PUSHBUTTON_FLAG) !== 0) return { type: "staticText" };
    void RADIO_FLAG; // radio and checkbox are both printed as a mark
    return { type: "checkbox", onState: onStateOf(dict, doc) };
  }

  if (ft === "/Tx") {
    const maxLen = asNumber(inherited(dict, doc, "MaxLen"));
    if ((flags & COMB_FLAG) !== 0 && maxLen && maxLen > 0) {
      return { type: "comb", comb: { cells: maxLen } };
    }
    return { type: "text" };
  }

  return { type: "text" };
}

/**
 * The key of the widget's normal appearance dictionary that is not /Off:
 * the value this particular option sets when it is chosen.
 */
function onStateOf(dict: PDFDict, doc: PDFDocument): string | undefined {
  const ap = deref(doc, dict.get(PDFName.of("AP")));
  if (!(ap instanceof PDFDict)) return undefined;

  const normal = deref(doc, ap.get(PDFName.of("N")));
  if (!(normal instanceof PDFDict)) return undefined;

  const state = normal
    .keys()
    .map((key) => String(key).replace(/^\//, ""))
    .find((key) => key !== "Off");

  // "On" is the default two-state checkbox value and distinguishes nothing.
  return state && state !== "On" ? state : undefined;
}

function fieldName(dict: PDFDict): string | undefined {
  const raw = dict.get(PDFName.of("T"));
  if (raw instanceof PDFHexString || raw instanceof PDFString) {
    try {
      return raw.decodeText();
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function numbers(doc: PDFDocument, value: unknown): number[] | undefined {
  const array = deref(doc, value);
  if (!(array instanceof PDFArray)) return undefined;

  const out = array.asArray().map((n) => Number(deref(doc, n)?.toString()));
  return out.every((n) => Number.isFinite(n)) ? out : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (value instanceof PDFNumber) return value.asNumber();
  const n = Number(String(value));
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Field names are not reliably unique.
 *
 * On Form 1040 the five filing-status options are one radio group in which
 * two pairs of widgets share a name: the option is identified by its
 * appearance state, not by /T. Emitting those as-is would produce a draft
 * that fails the specification's own duplicate-id rule, so the on-state
 * disambiguates, and a positional suffix is the last resort.
 */
function uniqueIds(widgets: Widget[], skipped: string[]): string[] {
  const taken = new Map<string, number>();

  return widgets.map((widget) => {
    const base = sanitise(widget.onState ? `${widget.name}.${widget.onState}` : widget.name);

    const seen = taken.get(base);
    if (seen === undefined) {
      taken.set(base, 1);
      return base;
    }

    taken.set(base, seen + 1);
    const id = `${base}.${seen + 1}`;
    skipped.push(`${widget.name}: name is not unique, drafted as '${id}'`);
    return id;
  });
}

function sanitise(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[^A-Za-z0-9]+/, "");
  return cleaned.length > 0 ? cleaned : "field";
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

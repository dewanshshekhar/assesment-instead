/**
 * Reference renderer.
 *
 * It consumes a RenderPlan and a source PDF, and nothing else. It never sees
 * a template, a data set, or the reference resolver — which is the point: if
 * this file needed any of those, the claim that a host application can draw
 * from a plan with its own stack would not be true.
 *
 * Everything here is metric-dependent work: measuring text and applying the
 * overflow policy the plan asks for.
 */

import { createHash } from "node:crypto";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { Diagnostic, PlacedText, RenderPlan } from "../../spec/types.ts";
import { alignedX, baselineOffset, wrapLines, type Rect } from "./layout.ts";

const FONTS: Record<string, (typeof StandardFonts)[keyof typeof StandardFonts]> = {
  Helvetica: StandardFonts.Helvetica,
  "Helvetica-Bold": StandardFonts.HelveticaBold,
  Courier: StandardFonts.Courier,
  "Courier-Bold": StandardFonts.CourierBold,
  "Times-Roman": StandardFonts.TimesRoman,
};

/**
 * Rendering the same plan onto the same PDF twice produces the same bytes.
 *
 * PDF writers stamp a modification time on save, which makes otherwise
 * identical output differ. That defeats caching, byte-diffing two runs, and
 * golden-file regression tests — all things worth having when the artefact is
 * a tax return. The filing timestamp belongs to the return data, not to the
 * document metadata, so the metadata is pinned unless a caller asks for a
 * real one.
 */
const DETERMINISTIC_TIMESTAMP = new Date(Date.UTC(2000, 0, 1));

export interface RenderOptions {
  /** Refuse to draw when the PDF is not the one the plan was measured against. */
  enforceDigest?: boolean;
  /** Stamped into the output. Defaults to a fixed value, for reproducibility. */
  timestamp?: Date;
}

export interface RenderResult {
  pdf: Uint8Array;
  diagnostics: Diagnostic[];
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function render(
  plan: RenderPlan,
  sourcePdf: Uint8Array,
  options: RenderOptions = {},
): Promise<RenderResult> {
  const diagnostics: Diagnostic[] = [...plan.diagnostics];

  const digest = sha256(sourcePdf);
  if (digest !== plan.source.sha256) {
    const message =
      `source PDF digest ${digest} does not match the plan's ${plan.source.sha256}; ` +
      "coordinates may no longer be valid";
    if (options.enforceDigest !== false) {
      diagnostics.push({ severity: "error", code: "source/digest-mismatch", message });
      return { pdf: sourcePdf, diagnostics };
    }
    diagnostics.push({ severity: "warning", code: "source/digest-mismatch", message });
  }

  const doc = await PDFDocument.load(sourcePdf);
  doc.setModificationDate(options.timestamp ?? DETERMINISTIC_TIMESTAMP);

  const pages = doc.getPages();
  const fontCache = new Map<string, PDFFont>();

  const fontFor = async (name: string): Promise<PDFFont> => {
    const key = FONTS[name] ? name : "Helvetica";
    if (!fontCache.has(key)) fontCache.set(key, await doc.embedFont(FONTS[key]));
    return fontCache.get(key)!;
  };

  for (const placement of plan.placements) {
    const page = pages[placement.page];
    if (!page) {
      diagnostics.push({
        severity: "error",
        code: "page/out-of-range",
        entryId: placement.fieldId,
        message: `page ${placement.page} does not exist in the source PDF`,
      });
      continue;
    }

    const font = await fontFor(placement.font);
    if (placement.cells) drawComb(page, font, placement, page.getHeight());
    else drawText(page, font, placement, page.getHeight(), diagnostics);
  }

  return { pdf: await doc.save(), diagnostics };
}

function drawComb(page: PDFPage, font: PDFFont, placement: PlacedText, pageHeight: number): void {
  const baseline =
    pageHeight - placement.rect[1] - baselineOffset(placement.rect as Rect, placement.size, "middle");

  for (const cell of placement.cells ?? []) {
    if (cell.char === "") continue;
    const width = font.widthOfTextAtSize(cell.char, placement.size);
    page.drawText(cell.char, {
      x: cell.x + (cell.width - width) / 2,
      y: baseline,
      size: placement.size,
      font,
      color: hexToRgb(placement.color),
    });
  }
}

function drawText(
  page: PDFPage,
  font: PDFFont,
  placement: PlacedText,
  pageHeight: number,
  diagnostics: Diagnostic[],
): void {
  const [x, y, w, h] = placement.rect;
  const { top, right, bottom, left } = placement.padding;
  const inner: Rect = [
    x + left,
    y + top,
    Math.max(0, w - left - right),
    Math.max(0, h - top - bottom),
  ];

  const color = hexToRgb(placement.color);
  let text = placement.text;
  let size = placement.size;
  const measure = (s: string, at: number = size) => font.widthOfTextAtSize(s, at);

  if (placement.overflow === "wrap") {
    const lines = wrapLines(text, inner[2], (s) => measure(s));
    lines.forEach((line, i) => {
      page.drawText(line, {
        x: alignedX(inner, measure(line), placement.align),
        y: pageHeight - inner[1] - baselineOffset(inner, size, "top") - i * size * placement.lineHeight,
        size,
        font,
        color,
      });
    });
    return;
  }

  if (measure(text) > inner[2]) {
    switch (placement.overflow) {
      case "shrink":
        while (size > placement.minSize && measure(text, size) > inner[2]) size -= 0.25;
        break;
      case "truncate":
        while (text.length > 0 && measure(text) > inner[2]) text = text.slice(0, -1);
        break;
      case "ellipsis":
        while (text.length > 1 && measure(`${text}…`) > inner[2]) text = text.slice(0, -1);
        text = `${text}…`;
        break;
      default:
        diagnostics.push({
          severity: "error",
          code: "layout/overflow",
          entryId: placement.fieldId,
          message: `"${placement.text}" is ${measure(placement.text).toFixed(1)}pt wide but the box allows ${inner[2].toFixed(1)}pt`,
        });
        return;
    }
  }

  page.drawText(text, {
    x: alignedX(inner, measure(text, size), placement.align),
    y: pageHeight - inner[1] - baselineOffset(inner, size, placement.vAlign),
    size,
    font,
    color,
  });
}

function hexToRgb(hex: string) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return rgb(0, 0, 0);
  return rgb(parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255);
}

/** Renders continuation statements onto appended pages. */
export async function appendStatements(
  pdf: Uint8Array,
  plan: RenderPlan,
  options: RenderOptions = {},
): Promise<Uint8Array> {
  if (plan.statements.length === 0) return pdf;

  const doc = await PDFDocument.load(pdf);
  doc.setModificationDate(options.timestamp ?? DETERMINISTIC_TIMESTAMP);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  for (const statement of plan.statements) {
    const page = doc.addPage([612, 792]);
    const top = (y: number) => 792 - y;

    page.drawText(statement.title, { x: 36, y: top(48), size: 12, font: bold, color: rgb(0, 0, 0) });
    page.drawText(`Statement ${statement.statementId} — continued from ${statement.sourceEntryId}`, {
      x: 36,
      y: top(64),
      size: 8,
      font,
      color: rgb(0.35, 0.35, 0.35),
    });

    statement.columns.forEach((column, i) => {
      page.drawText(column, { x: 36 + i * 240, y: top(92), size: 9, font: bold, color: rgb(0, 0, 0) });
    });

    statement.rows.forEach((row, r) => {
      row.forEach((value, i) => {
        page.drawText(value, { x: 36 + i * 240, y: top(110 + r * 16), size: 9, font, color: rgb(0, 0, 0) });
      });
    });
  }

  return doc.save();
}

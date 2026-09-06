/**
 * Reference renderer.
 *
 * This exists to prove the specification is implementable and to give the
 * examples something to draw with. It is deliberately small: a host
 * application is expected to consume the RenderPlan and draw with its own
 * stack, which is why every metric-dependent decision lives here rather than
 * in the plan.
 */

import { createHash } from "node:crypto";
import { PDFDocument, StandardFonts, rgb, type PDFFont } from "pdf-lib";
import type { AnnotationTemplate, Diagnostic, PlacedText, RenderPlan } from "../../spec/types.ts";
import { alignedX, baselineOffset, wrapLines, type Rect } from "./layout.ts";

const FONTS: Record<string, (typeof StandardFonts)[keyof typeof StandardFonts]> = {
  Helvetica: StandardFonts.Helvetica,
  "Helvetica-Bold": StandardFonts.HelveticaBold,
  Courier: StandardFonts.Courier,
  "Courier-Bold": StandardFonts.CourierBold,
  "Times-Roman": StandardFonts.TimesRoman,
};

export interface RenderOptions {
  /** Refuse to render when the source PDF is not the one the template was measured against. */
  enforceDigest?: boolean;
}

export interface RenderResult {
  pdf: Uint8Array;
  diagnostics: Diagnostic[];
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function render(
  template: AnnotationTemplate,
  plan: RenderPlan,
  sourcePdf: Uint8Array,
  options: RenderOptions = {},
): Promise<RenderResult> {
  const diagnostics: Diagnostic[] = [...plan.diagnostics];

  const digest = sha256(sourcePdf);
  if (digest !== template.template.source.sha256) {
    const message =
      `source PDF digest ${digest} does not match the template's ` +
      `${template.template.source.sha256}; coordinates may no longer be valid`;
    if (options.enforceDigest !== false) {
      diagnostics.push({ severity: "error", code: "source/digest-mismatch", message });
      return { pdf: sourcePdf, diagnostics };
    }
    diagnostics.push({ severity: "warning", code: "source/digest-mismatch", message });
  }

  const doc = await PDFDocument.load(sourcePdf);
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
    const pageHeight = page.getHeight();
    const style = styleOf(template, placement.fieldId);

    if (placement.cells) {
      drawComb(page, font, placement, pageHeight);
      continue;
    }

    drawText(page, font, placement, pageHeight, style, diagnostics);
  }

  return { pdf: await doc.save(), diagnostics };
}

interface ResolvedStyle {
  vAlign: "top" | "middle" | "bottom";
  overflow: "error" | "shrink" | "truncate" | "ellipsis" | "wrap";
  minSize: number;
  lineHeight: number;
  padding: { top: number; right: number; bottom: number; left: number };
}

/**
 * The plan intentionally carries only what is needed to draw a string. The
 * remaining presentation details are read back from the template so that the
 * plan stays a stable, minimal interchange format.
 */
function styleOf(template: AnnotationTemplate, fieldId: string): ResolvedStyle {
  const baseId = fieldId.replace(/#cents$/, "").replace(/^.*\.overflow\./, "");
  const found = findField(template, baseId);
  const style = { ...template.defaults?.style, ...found?.style };

  // Padding insets a text box. A checkbox is a mark centred in the ruled
  // square itself, so inherited text padding must not shrink it -- on a 10pt
  // box, a default 3/4pt inset leaves no room for the glyph at all.
  const p = found?.type === "checkbox" ? {} : (style.padding ?? {});

  return {
    vAlign: style.vAlign ?? "middle",
    overflow: style.overflow ?? "error",
    minSize: style.minSize ?? 6,
    lineHeight: style.lineHeight ?? 1.15,
    padding: { top: p.top ?? 0, right: p.right ?? 0, bottom: p.bottom ?? 0, left: p.left ?? 0 },
  };
}

function findField(template: AnnotationTemplate, id: string) {
  for (const entry of template.entries) {
    if (entry.kind === "field" && entry.id === id) return entry;
    if (entry.kind === "repeat") {
      const hit = entry.row.fields.find((f) => f.id === id || id.endsWith(`.${f.id}`));
      if (hit) return hit;
    }
  }
  return undefined;
}

function drawComb(page: any, font: PDFFont, placement: PlacedText, pageHeight: number): void {
  const [, y, , h] = placement.rect;
  const baseline = pageHeight - y - baselineOffset(placement.rect as Rect, placement.size, "middle");

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
  void h;
}

function drawText(
  page: any,
  font: PDFFont,
  placement: PlacedText,
  pageHeight: number,
  style: ResolvedStyle,
  diagnostics: Diagnostic[],
): void {
  const [x, y, w, h] = placement.rect;
  const inner: Rect = [
    x + style.padding.left,
    y + style.padding.top,
    Math.max(0, w - style.padding.left - style.padding.right),
    Math.max(0, h - style.padding.top - style.padding.bottom),
  ];

  let text = placement.text;
  let size = placement.size;
  const measure = (s: string, at = size) => font.widthOfTextAtSize(s, at);

  if (style.overflow === "wrap") {
    const lines = wrapLines(text, inner[2], (s) => measure(s));
    lines.forEach((line, i) => {
      const lx = alignedX(inner, measure(line), placement.align);
      const ly = pageHeight - inner[1] - baselineOffset(inner, size, "top") - i * size * style.lineHeight;
      page.drawText(line, { x: lx, y: ly, size, font, color: hexToRgb(placement.color) });
    });
    return;
  }

  if (measure(text) > inner[2]) {
    switch (style.overflow) {
      case "shrink":
        while (size > style.minSize && measure(text, size) > inner[2]) size -= 0.25;
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
    y: pageHeight - inner[1] - baselineOffset(inner, size, style.vAlign),
    size,
    font,
    color: hexToRgb(placement.color),
  });
}

function hexToRgb(hex: string) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return rgb(0, 0, 0);
  return rgb(parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255);
}

/** Renders continuation statements onto appended pages. */
export async function appendStatements(pdf: Uint8Array, plan: RenderPlan): Promise<Uint8Array> {
  if (plan.statements.length === 0) return pdf;

  const doc = await PDFDocument.load(pdf);
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

/**
 * Generates the blank fixture form one example template is measured against.
 *
 * The official 2025 forms in `forms/` cover everything the specification does
 * except one thing: neither of them rules dollars and cents into separate
 * columns. This fixture does, so the feature stays demonstrated. Generation is
 * byte-reproducible, which keeps `source.sha256` a real, checkable digest.
 *
 * For a production template you run `cli.ts import` against the official PDF
 * instead; see tools/README.md.
 */

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const RULE = rgb(0.62, 0.62, 0.62);
const INK = rgb(0, 0, 0);

/**
 * Fixed so that generation is byte-reproducible. Without this, pdf-lib
 * stamps the current time into the document and the SHA-256 recorded in the
 * templates would change on every run, which would make the digest check
 * meaningless.
 */
const EPOCH = new Date(Date.UTC(2024, 0, 1));

function pinMetadata(doc: PDFDocument): void {
  doc.setCreationDate(EPOCH);
  doc.setModificationDate(EPOCH);
  doc.setProducer("tfas-fixtures");
  doc.setCreator("tfas-fixtures");
}

interface Ctx {
  page: PDFPage;
  font: PDFFont;
  bold: PDFFont;
}

/** Draws using top-left origin coordinates, converting once at the edge. */
function box(ctx: Ctx, x: number, y: number, w: number, h: number): void {
  ctx.page.drawRectangle({
    x,
    y: PAGE_HEIGHT - y - h,
    width: w,
    height: h,
    borderColor: RULE,
    borderWidth: 0.75,
  });
}

function label(ctx: Ctx, x: number, y: number, text: string, size = 7, bold = false): void {
  ctx.page.drawText(text, {
    x,
    y: PAGE_HEIGHT - y - size,
    size,
    font: bold ? ctx.bold : ctx.font,
    color: INK,
  });
}

/** A ruled comb box: one outer rect with interior tick marks. */
function comb(ctx: Ctx, x: number, y: number, w: number, h: number, cells: number, gaps: Record<number, number>): void {
  box(ctx, x, y, w, h);
  const totalGap = Object.values(gaps).reduce((a, b) => a + b, 0);
  const cellWidth = (w - totalGap) / cells;
  let gapBefore = 0;
  for (let i = 1; i < cells; i += 1) {
    const gap = gaps[i] ?? 0;
    if (gap === 0) {
      const tick = x + i * cellWidth + gapBefore;
      ctx.page.drawLine({
        start: { x: tick, y: PAGE_HEIGHT - y - h },
        end: { x: tick, y: PAGE_HEIGHT - y },
        color: RULE,
        thickness: 0.5,
      });
    }
    gapBefore += gap;
  }
}

/** An amount line: caption on the left, dollars box and ruled cents column. */
function amountLine(ctx: Ctx, y: number, caption: string): void {
  label(ctx, 36, y + 3, caption, 8);
  box(ctx, 462, y, 92, 14);
  box(ctx, 556, y, 30, 14);
}

export async function buildForm1040(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle("Form 1040 (fixture) — U.S. Individual Income Tax Return");
  pinMetadata(doc);
  const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  const ctx: Ctx = {
    page,
    font: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
  };

  label(ctx, 36, 36, "Form 1040", 16, true);
  label(ctx, 130, 42, "U.S. Individual Income Tax Return", 11, true);
  label(ctx, 470, 40, "Tax year 2024", 9);
  label(ctx, 36, 60, "Layout fixture for the annotation specification examples.", 7);

  label(ctx, 36, 78, "Your first name and middle initial");
  box(ctx, 36, 88, 190, 16);
  label(ctx, 232, 78, "Last name");
  box(ctx, 232, 88, 190, 16);
  label(ctx, 432, 78, "Your social security number");
  comb(ctx, 432, 88, 144, 16, 9, { 3: 8, 5: 8 });

  label(ctx, 36, 120, "Filing status — check only one box", 8, true);
  const statuses: [number, string][] = [
    [40, "Single"],
    [130, "Married filing jointly"],
    [260, "Married filing separately"],
    [400, "Head of household"],
  ];
  for (const [x, text] of statuses) {
    box(ctx, x, 132, 10, 10);
    label(ctx, x + 14, 134, text);
  }

  label(ctx, 36, 158, "Home address (number and street)");
  box(ctx, 36, 168, 386, 16);
  label(ctx, 432, 158, "Apt. no.");
  box(ctx, 432, 168, 144, 16);

  label(ctx, 36, 208, "Income", 11, true);
  label(ctx, 462, 212, "Dollars", 7);
  label(ctx, 556, 212, "Cents", 7);

  amountLine(ctx, 232, "1a   Total amount from Form(s) W-2, box 1");
  amountLine(ctx, 254, "2b   Taxable interest");
  amountLine(ctx, 276, "3b   Ordinary dividends");
  amountLine(ctx, 298, "8    Additional income from Schedule 1, line 10");
  amountLine(ctx, 320, "9    Total income. Add lines 1a through 8");
  amountLine(ctx, 342, "11   Adjusted gross income");

  label(ctx, 36, 380, "Payments", 11, true);
  amountLine(ctx, 400, "25a  Federal income tax withheld from Form(s) W-2");

  label(ctx, 36, 690, "Sign here", 11, true);
  label(ctx, 36, 706, "Your occupation");
  box(ctx, 36, 716, 220, 16);
  label(ctx, 432, 706, "Date");
  box(ctx, 432, 716, 144, 16);

  return doc.save();
}

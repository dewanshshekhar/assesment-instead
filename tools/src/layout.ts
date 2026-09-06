/**
 * Pure geometry. Nothing here needs font metrics, which is what lets the
 * render plan be produced once and drawn by any engine.
 */

export type Rect = [x: number, y: number, width: number, height: number];

export interface Padding {
  top?: number;
  right?: number;
  bottom?: number;
  left?: number;
}

export interface CombSpec {
  cells: number;
  gaps?: Record<string, number>;
}

export interface Cell {
  x: number;
  width: number;
  char: string;
}

/** Shrinks a rect by its padding. */
export function inset(rect: Rect, padding: Padding = {}): Rect {
  const [x, y, w, h] = rect;
  const l = padding.left ?? 0;
  const t = padding.top ?? 0;
  const r = padding.right ?? 0;
  const b = padding.bottom ?? 0;
  return [x + l, y + t, Math.max(0, w - l - r), Math.max(0, h - t - b)];
}

/** Translates a rect, used to place a repeat row relative to its group origin. */
export function translate(rect: Rect, dx: number, dy: number): Rect {
  return [rect[0] + dx, rect[1] + dy, rect[2], rect[3]];
}

/**
 * Lays out one character per cell.
 *
 * Cell width is derived so that a template author never hand-computes it:
 *   cellWidth = (width - sum(gaps)) / cells
 *
 * `gaps` is keyed by the number of cells preceding the gap, so an SSN ruled
 * 3-2-4 is `{ cells: 9, gaps: { "3": 6, "5": 6 } }`. Text shorter than the
 * cell count fills from the left and leaves the remaining cells blank.
 */
export function combCells(rect: Rect, comb: CombSpec, text: string): Cell[] {
  const [x, , width] = rect;
  const gaps = comb.gaps ?? {};
  const totalGap = Object.values(gaps).reduce((a, b) => a + b, 0);
  const cellWidth = (width - totalGap) / comb.cells;

  // Positions are computed from the index rather than accumulated, so that
  // rounding error cannot creep across the row and push the last cell past
  // the edge of the box.
  const cells: Cell[] = [];
  let gapBefore = 0;
  for (let i = 0; i < comb.cells; i += 1) {
    if (i > 0) gapBefore += gaps[String(i)] ?? 0;
    cells.push({ x: x + i * cellWidth + gapBefore, width: cellWidth, char: text[i] ?? "" });
  }
  return cells;
}

/** Left edge at which text of the given width satisfies the alignment. */
export function alignedX(rect: Rect, textWidth: number, align: "left" | "center" | "right"): number {
  const [x, , width] = rect;
  if (align === "right") return x + width - textWidth;
  if (align === "center") return x + (width - textWidth) / 2;
  return x;
}

/**
 * Baseline offset from the top of the rect. Cap height is approximated at
 * 0.72 em, which is close enough for the single-line boxes on a tax form and
 * avoids depending on any particular font's metrics table.
 */
export function baselineOffset(
  rect: Rect,
  fontSize: number,
  vAlign: "top" | "middle" | "bottom",
): number {
  const [, , , height] = rect;
  const cap = fontSize * 0.72;
  if (vAlign === "top") return cap;
  if (vAlign === "bottom") return height;
  return (height + cap) / 2;
}

/** Converts a top-left origin rect to the PDF's bottom-left user space. */
export function toPdfSpace(rect: Rect, pageHeight: number): Rect {
  const [x, y, w, h] = rect;
  return [x, pageHeight - y - h, w, h];
}

/** Greedy wrap used by `overflow: "wrap"` and by multilineText. */
export function wrapLines(text: string, maxWidth: number, measure: (s: string) => number): string[] {
  const paragraphs = text.split(/\r?\n/);
  const lines: string[] = [];

  for (const paragraph of paragraphs) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push("");
      continue;
    }
    let line = words[0];
    for (const word of words.slice(1)) {
      const candidate = `${line} ${word}`;
      if (measure(candidate) <= maxWidth) line = candidate;
      else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines;
}

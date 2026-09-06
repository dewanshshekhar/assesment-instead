import { test } from "node:test";
import assert from "node:assert/strict";
import { combCells, alignedX, inset, translate, wrapLines, toPdfSpace, type Rect } from "../src/layout.ts";

test("derives comb cell width from the rect and the declared gaps", () => {
  const rect: Rect = [432, 88, 144, 16];
  const cells = combCells(rect, { cells: 9, gaps: { "3": 8, "5": 8 } }, "412889017");

  assert.equal(cells.length, 9);
  const near = (a: number, b: number, what: string) =>
    assert.ok(Math.abs(a - b) < 1e-9, `${what}: expected ~${b}, got ${a}`);

  near(cells[0].width, (144 - 16) / 9, "cell width");
  assert.equal(cells.map((c) => c.char).join(""), "412889017");

  // The 3-2-4 grouping puts extra space after the third and fifth cells.
  near(cells[3].x - (cells[2].x + cells[2].width), 8, "gap after cell 3");
  near(cells[5].x - (cells[4].x + cells[4].width), 8, "gap after cell 5");
  near(cells[2].x - (cells[1].x + cells[1].width), 0, "no gap after cell 2");

  // The last cell must still end inside the box.
  const last = cells[8];
  near(last.x + last.width, rect[0] + rect[2], "right edge of the last cell");
});

test("leaves trailing comb cells blank when the value is short", () => {
  const cells = combCells([0, 0, 90, 16], { cells: 9 }, "4128");
  assert.equal(cells.map((c) => c.char).join(""), "4128");
  assert.deepEqual(cells.slice(4).map((c) => c.char), ["", "", "", "", ""]);
});

test("aligns text within the box", () => {
  const rect: Rect = [100, 0, 90, 14];
  assert.equal(alignedX(rect, 30, "left"), 100);
  assert.equal(alignedX(rect, 30, "right"), 160);
  assert.equal(alignedX(rect, 30, "center"), 130);
});

test("insets by padding and never produces a negative extent", () => {
  assert.deepEqual(inset([10, 10, 100, 20], { left: 3, right: 4, top: 1, bottom: 2 }), [13, 11, 93, 17]);
  assert.deepEqual(inset([10, 10, 5, 5], { left: 10, right: 10 }), [20, 10, 0, 5]);
});

test("translates a row rect by its group origin", () => {
  assert.deepEqual(translate([0, 0, 300, 14], 36, 396), [36, 396, 300, 14]);
});

test("flips a top-left rect into PDF user space exactly once", () => {
  assert.deepEqual(toPdfSpace([36, 88, 190, 16], 792), [36, 792 - 88 - 16, 190, 16]);
});

test("wraps greedily on a measured width", () => {
  const measure = (s: string) => s.length * 5;
  assert.deepEqual(wrapLines("one two three four", 50, measure), ["one two", "three four"]);
  assert.deepEqual(wrapLines("a\nb", 50, measure), ["a", "b"]);
});

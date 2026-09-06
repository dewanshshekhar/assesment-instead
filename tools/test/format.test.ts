import { test } from "node:test";
import assert from "node:assert/strict";
import { formatValue, round, splitCents } from "../src/format.ts";

test("rounds halves away from zero under half-up", () => {
  assert.equal(round(0.5, 0, "half-up"), 1);
  assert.equal(round(1.5, 0, "half-up"), 2);
  assert.equal(round(-0.5, 0, "half-up"), -1);
  assert.equal(round(2.675, 2, "half-up"), 2.68, "binary representation must not drag 2.675 down");
  assert.equal(round(1.005, 2, "half-up"), 1.01);
});

test("rounds to even under half-even", () => {
  assert.equal(round(0.5, 0, "half-even"), 0);
  assert.equal(round(1.5, 0, "half-even"), 2);
  assert.equal(round(2.5, 0, "half-even"), 2);
});

test("truncates toward zero", () => {
  assert.equal(round(1.99, 0, "truncate"), 1);
  assert.equal(round(-1.99, 0, "truncate"), -1);
});

test("currency defaults to whole dollars, parentheses and blank zeros", () => {
  assert.equal(formatValue("currency", 1234.56), "1235");
  assert.equal(formatValue("currency", -1234.56), "(1235)");
  assert.equal(formatValue("currency", 0), "");
  assert.equal(formatValue("currency", 0, { blankIfZero: false }), "0");
});

test("currency honours explicit decimals, separators and sign style", () => {
  assert.equal(formatValue("currency", 1234.5, { decimals: 2 }), "1234.50");
  assert.equal(formatValue("currency", 1234567.89, { decimals: 2, thousands: true }), "1,234,567.89");
  assert.equal(formatValue("currency", -50, { decimals: 2, negative: "minus" }), "-50.00");
  assert.equal(formatValue("currency", -50, { decimals: 2, negative: "none" }), "50.00");
});

test("percentages are printed in the units they arrive in", () => {
  assert.equal(formatValue("percentage", 12.5), "12.50%");
});

test("dates are reformatted from the string, never through a local Date", () => {
  assert.equal(formatValue("date", "2025-03-14"), "03/14/2025");
  assert.equal(formatValue("date", "2025-03-14T23:45:00Z", { dateFormat: "MM/DD/YY" }), "03/14/25");
  assert.equal(formatValue("date", "2025-03-14", { dateFormat: "YYYY-MM-DD" }), "2025-03-14");
});

test("empty input produces an empty string, not a zero", () => {
  assert.equal(formatValue("currency", undefined), "");
  assert.equal(formatValue("text", null), "");
  assert.equal(formatValue("text", ""), "");
});

test("splits a formatted amount into dollar and cent columns", () => {
  assert.deepEqual(splitCents("1234.56"), { dollars: "1234", cents: "56" });
  assert.deepEqual(splitCents("(1,234.56)"), { dollars: "(1,234)", cents: "56" });
  assert.deepEqual(splitCents(""), { dollars: "", cents: "" });
  assert.deepEqual(splitCents("1234"), { dollars: "1234", cents: "" });
});

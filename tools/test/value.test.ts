import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, isChecked, EvaluationError } from "../src/value.ts";
import type { Json } from "../src/reference.ts";

const data: Json = {
  w2: [{ wages: 100 }, { wages: 250.5 }],
  filingStatus: "MARRIED_FILING_JOINTLY",
  taxpayer: { ssn: "412-88-9017", nickname: null },
  preferred: {},
};

test("aggregates a multi-valued reference", () => {
  assert.equal(evaluate({ ref: "$.w2[*].wages", aggregate: "sum" }, { root: data }).value, 350.5);
  assert.equal(evaluate({ ref: "$.w2[*].wages", aggregate: "count" }, { root: data }).value, 2);
  assert.equal(evaluate({ ref: "$.w2[*].wages", aggregate: "max" }, { root: data }).value, 250.5);
  assert.equal(evaluate({ ref: "$.w2[*].wages", aggregate: "first" }, { root: data }).value, 100);
});

test("refuses to silently pick one node from a multi-valued reference", () => {
  assert.throws(
    () => evaluate({ ref: "$.w2[*].wages" }, { root: data }),
    (error: unknown) => error instanceof EvaluationError && error.code === "value/ambiguous",
  );
});

test("falls back in order, then to the default", () => {
  const spec = { ref: "$.taxpayer.preferredName", fallback: ["$.taxpayer.nickname", "$.filingStatus"] };
  assert.equal(evaluate(spec, { root: data }).value, "MARRIED_FILING_JOINTLY");

  const missing = evaluate({ ref: "$.nothing.here", default: 0 }, { root: data });
  assert.equal(missing.value, 0);
  assert.equal(missing.missing, true);
});

test("a reference selecting nothing yields undefined rather than an error", () => {
  const result = evaluate({ ref: "$.nothing.here" }, { root: data });
  assert.equal(result.value, undefined);
  assert.equal(result.missing, true);
});

test("applies transforms in the order written", () => {
  assert.equal(evaluate({ ref: "$.taxpayer.ssn", transform: ["digitsOnly"] }, { root: data }).value, "412889017");
  assert.equal(evaluate({ const: " dana ", transform: ["trim", "upper"] }, { root: data }).value, "DANA");
  assert.equal(evaluate({ const: -5, transform: ["abs"] }, { root: data }).value, 5);
  assert.equal(evaluate({ const: 5, transform: ["negate"] }, { root: data }).value, -5);
});

test("rejects a numeric aggregate over non-numeric nodes", () => {
  assert.throws(
    () => evaluate({ ref: "$.taxpayer.ssn", aggregate: "sum" }, { root: data }),
    (error: unknown) => error instanceof EvaluationError && error.code === "value/not-numeric",
  );
});

test("a checkbox is marked only when the predicate holds", () => {
  const spec = { ref: "$.filingStatus", equals: "MARRIED_FILING_JOINTLY" };
  assert.equal(isChecked(spec, evaluate(spec, { root: data })), true);

  const other = { ref: "$.filingStatus", equals: "SINGLE" };
  assert.equal(isChecked(other, evaluate(other, { root: data })), false);

  const absent = { ref: "$.nothing" };
  assert.equal(isChecked(absent, evaluate(absent, { root: data })), false);
});

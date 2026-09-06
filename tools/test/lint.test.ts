import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import type { AnnotationTemplate } from "../../spec/types.ts";
import { lint } from "../src/lint.ts";
import type { Json } from "../src/reference.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = <T,>(p: string): T => JSON.parse(readFileSync(resolvePath(HERE, p), "utf8")) as T;

const schema = read<unknown>("../../spec/annotation-template.schema.json");
const data = read<Json>("../../examples/sample-return.json");
const base = read<AnnotationTemplate>("../../templates/us.irs.f1040.2024.json");
const scheduleC = read<AnnotationTemplate>("../../templates/us.irs.f1040sc.2025.json");

const codes = (template: AnnotationTemplate, withData = false, strictData = false) =>
  lint(template, { schema, data: withData ? data : undefined, strictData }).map((d) => d.code);

const form2025 = read<AnnotationTemplate>("../../templates/us.irs.f1040.2025.json");

test("the shipped templates are clean against the schema and the sample data", () => {
  for (const template of [form2025, scheduleC, base]) {
    assert.deepEqual(lint(template, { schema, data }), [], `${template.template.id} is not clean`);
  }
});

test("rejects a document that does not satisfy the schema", () => {
  const broken = structuredClone(base) as any;
  broken.entries[0].rect = [36, 88, 190];
  assert.ok(codes(broken).includes("schema/invalid"));
});

test("catches a box that falls off the page", () => {
  const broken = structuredClone(base) as any;
  broken.entries[0].rect = [36, 780, 190, 40];
  assert.ok(codes(broken).includes("rect/out-of-bounds"));
});

test("catches a repeat whose last slot falls off the page", () => {
  const broken = structuredClone(scheduleC) as any;
  const repeat = broken.entries.find((e: any) => e.kind === "repeat");
  repeat.capacity = 40;
  assert.ok(codes(broken).includes("rect/out-of-bounds"));
});

test("checks the last slot of a horizontal repeat too", () => {
  const broken = structuredClone(scheduleC) as any;
  const repeat = broken.entries.find((e: any) => e.kind === "repeat");
  repeat.step = [200, 0];
  repeat.capacity = 6;
  assert.ok(codes(broken).includes("rect/out-of-bounds"));
});

test("catches duplicate entry ids", () => {
  const broken = structuredClone(base) as any;
  broken.entries.push(structuredClone(broken.entries[0]));
  assert.ok(codes(broken).includes("id/duplicate"));
});

test("catches a multi-valued reference with no aggregate", () => {
  const broken = structuredClone(base) as any;
  const line = broken.entries.find((e: any) => e.id === "p1.line1a");
  delete line.value.aggregate;
  assert.ok(codes(broken).includes("value/ambiguous"));
});

test("catches reference syntax outside the supported subset", () => {
  const broken = structuredClone(base) as any;
  broken.entries[0].value = { ref: "$..wages" };
  assert.ok(codes(broken).includes("reference/syntax"));
});

test("catches a comb whose cells cannot fit in its box", () => {
  const broken = structuredClone(base) as any;
  const ssn = broken.entries.find((e: any) => e.id === "p1.ssn");
  ssn.comb = { cells: 9, gaps: { "3": 100, "5": 100 } };
  assert.ok(codes(broken).includes("comb/no-room"));

  const narrow = structuredClone(base) as any;
  narrow.entries.find((e: any) => e.id === "p1.ssn").rect = [432, 88, 30, 16];
  assert.ok(codes(narrow).includes("comb/narrow"));
});

test("warns when two boxes on the same page overlap", () => {
  const broken = structuredClone(base) as any;
  broken.entries.find((e: any) => e.id === "p1.lastName").rect = [36, 88, 190, 16];
  assert.ok(codes(broken).includes("rect/overlap"));
});

test("warns about a radio group with a single member", () => {
  const broken = structuredClone(base) as any;
  broken.entries = broken.entries.filter((e: any) => !/^p1\.status\.(single|mfs|hoh)$/.test(e.id));
  assert.ok(codes(broken).includes("radio/singleton"));
});

test("reports an unresolved reference only when asked", () => {
  const broken = structuredClone(base) as any;
  broken.entries[0].value = { ref: "@.taxpayer.middleName" };

  // An empty line is the normal case on a tax form, so this is not reported by
  // default; it is a binding-time aid for a fixture meant to exercise
  // every field.
  assert.ok(!codes(broken, true).includes("reference/unresolved"));
  assert.ok(codes(broken, true, true).includes("reference/unresolved"));
});

test("surfaces the plan's own diagnostics when sample data is supplied", () => {
  const broken = structuredClone(scheduleC) as any;
  const repeat = broken.entries.find((e: any) => e.kind === "repeat");
  repeat.overflow = "error";
  delete repeat.continuation;
  assert.ok(codes(broken, true).includes("repeat/overflow"));
});

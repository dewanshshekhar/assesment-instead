import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import type { AnnotationTemplate, BindingProfile } from "../../spec/types.ts";
import { buildPlan } from "../src/plan.ts";
import { lint } from "../src/lint.ts";
import type { Json } from "../src/reference.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = <T,>(p: string): T => JSON.parse(readFileSync(resolvePath(HERE, p), "utf8")) as T;

const schema = read<unknown>("../../spec/annotation-template.schema.json");
const scheduleC = read<AnnotationTemplate>("../../templates/us.irs.f1040sc.2025.json");
const canonical = read<Json>("../../examples/sample-return.json");
const altShape = read<Json>("../../examples/alt-shape-return.json");
const altProfile = read<BindingProfile>("../../examples/bindings/alt-shape.json");

test("the same template prints the same page from two unrelated data shapes", () => {
  const fromCanonical = buildPlan(scheduleC, canonical);
  const fromAlt = buildPlan(scheduleC, altShape, { bindings: altProfile.bindings });

  assert.deepEqual(fromAlt.diagnostics, []);
  assert.deepEqual(
    fromAlt.placements,
    fromCanonical.placements,
    "swapping the binding profile must change where values are read, not what is printed",
  );
  assert.deepEqual(fromAlt.statements, fromCanonical.statements);
});

test("the two data sets really are shaped differently", () => {
  // Otherwise the test above would prove nothing.
  assert.ok("taxReturn" in (canonical as object));
  assert.ok("soleProprietorships" in (altShape as object));

  const canonicalExpense = scheduleC.bindings!["business.expense.advertising"].ref!;
  const altExpense = altProfile.bindings["business.expense.advertising"].ref!;
  assert.notEqual(canonicalExpense, altExpense);
  assert.match(canonicalExpense, /expenses\[\?\(@\.line/, "canonical filters a list by IRS line number");
  assert.match(altExpense, /deductions\.advertising/, "the alternative keys expenses by name");
});

test("a field may override the binding without redefining it", () => {
  const plan = buildPlan(scheduleC, canonical);

  // Five accounting-method checkboxes share one concept and differ only by
  // `equals`. Losing that would mark every one of them, since the underlying
  // value is a truthy string.
  const marked = plan.placements.filter((p) => p.fieldId.startsWith("sc.method."));
  assert.deepEqual(marked.map((p) => p.fieldId), ["sc.method.cash"]);

  const participation = plan.placements.filter((p) => p.fieldId.startsWith("sc.materiallyParticipated."));
  assert.deepEqual(participation.map((p) => p.fieldId), ["sc.materiallyParticipated.yes"]);
});

test("a concept with no binding is an error, not a blank box", () => {
  const broken = structuredClone(scheduleC);
  delete broken.bindings!["business.income.grossReceipts"];

  const plan = buildPlan(broken, canonical);
  const unbound = plan.diagnostics.find((d) => d.code === "binding/unbound");

  assert.ok(unbound, "an unbound concept must be reported");
  assert.match(unbound.message, /business\.income\.grossReceipts/);
  assert.ok(!plan.placements.some((p) => p.fieldId === "sc.line1"));

  assert.ok(lint(broken, { schema }).some((d) => d.code === "binding/unbound"));
});

test("a binding nobody uses is reported", () => {
  const stale = structuredClone(scheduleC);
  stale.bindings!["business.income.somethingRemoved"] = { ref: "@.gone" };

  const codes = lint(stale, { schema });
  assert.ok(codes.some((d) => d.code === "binding/unused"));
});

test("concepts drive the repeat and the form's subject too", () => {
  // Both are as data-shaped a question as any field, so both go through bindings.
  const repeat = scheduleC.entries.find((e) => e.kind === "repeat") as any;
  assert.equal(repeat.over, "business.expense.otherItems");
  assert.equal(scheduleC.bind!.root, "form.subject");

  // And re-pointing the subject prints a different business from the same file.
  const second = structuredClone(scheduleC);
  second.bindings!["form.subject"] = { ref: "$.taxReturn.schedules.scheduleC[?(@.id == 'biz-2')]" };

  const plan = buildPlan(second, canonical);
  assert.equal(plan.placements.find((p) => p.fieldId === "sc.businessName")?.text, "Calder Avenue Ceramics");
  assert.equal(plan.placements.find((p) => p.fieldId === "sc.method.accrual")?.text, "X");
});

test("a template without concepts still works unchanged", () => {
  // The 1040 binds by reference throughout; concepts are opt-in, not a migration.
  const direct = read<AnnotationTemplate>("../../templates/us.irs.f1040.2025.json");
  assert.equal(direct.bindings, undefined);

  const plan = buildPlan(direct, canonical);
  assert.deepEqual(plan.diagnostics, []);
  assert.ok(plan.placements.length > 0);
});

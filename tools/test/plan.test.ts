import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import type { AnnotationTemplate } from "../../spec/types.ts";
import { buildPlan } from "../src/plan.ts";
import type { Json } from "../src/reference.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = <T,>(p: string): T => JSON.parse(readFileSync(resolvePath(HERE, p), "utf8")) as T;

const data = read<Json>("../../examples/sample-return.json");
const form1040 = read<AnnotationTemplate>("../../templates/us.irs.f1040.2024.json");
const scheduleC = read<AnnotationTemplate>("../../templates/us.irs.f1040sc.2024.json");

const textOf = (plan: ReturnType<typeof buildPlan>, id: string) =>
  plan.placements.find((p) => p.fieldId === id)?.text;

test("the example templates resolve without diagnostics", () => {
  for (const template of [form1040, scheduleC]) {
    const plan = buildPlan(template, data);
    assert.deepEqual(plan.diagnostics, [], `${template.template.id} produced diagnostics`);
  }
});

test("aggregates across a nested array onto a single line", () => {
  const plan = buildPlan(form1040, data);
  // 84,500.00 + 12,750.50
  assert.equal(textOf(plan, "p1.line1a"), "97250");
  assert.equal(textOf(plan, "p1.line1a#cents"), "50");
  // 9,800.00 + 1,400.25
  assert.equal(textOf(plan, "p1.line25a"), "11200");
  assert.equal(textOf(plan, "p1.line25a#cents"), "25");
});

test("sums the net profit of every Schedule C onto Form 1040", () => {
  const plan = buildPlan(form1040, data);
  assert.equal(textOf(plan, "p1.line8"), "48806");
  assert.equal(textOf(plan, "p1.line8#cents"), "95");
});

test("marks exactly one member of a radio group", () => {
  const plan = buildPlan(form1040, data);
  const marked = plan.placements.filter((p) => p.fieldId.startsWith("p1.status."));
  assert.deepEqual(marked.map((p) => p.fieldId), ["p1.status.mfj"]);
  assert.equal(marked[0].text, "X");
});

test("lays an identifier out one digit per comb cell", () => {
  const plan = buildPlan(form1040, data);
  const ssn = plan.placements.find((p) => p.fieldId === "p1.ssn");
  assert.ok(ssn?.cells, "the SSN placement should carry cells");
  assert.equal(ssn.cells.length, 9);
  assert.equal(ssn.cells.map((c) => c.char).join(""), "412889017");
});

test("omits a field whose visibleWhen does not hold", () => {
  const plan = buildPlan(form1040, data);
  assert.equal(textOf(plan, "p1.apt"), "Apt 4B");

  const withoutUnit = structuredClone(data) as any;
  delete withoutUnit.taxReturn.taxpayer.address.unit;
  assert.equal(textOf(buildPlan(form1040, withoutUnit), "p1.apt"), undefined);
});

test("the binding filter selects which business the Schedule C prints", () => {
  const plan = buildPlan(scheduleC, data);
  assert.equal(textOf(plan, "sc.businessName"), "Whitfield Structural Consulting");
  assert.equal(textOf(plan, "sc.line1"), "128400");

  const forSecondBusiness = structuredClone(scheduleC);
  forSecondBusiness.bind = { root: "$.taxReturn.schedules.scheduleC[?(@.id == 'biz-2')]" };
  const second = buildPlan(forSecondBusiness, data);

  assert.equal(textOf(second, "sc.businessName"), "Calder Avenue Ceramics");
  assert.equal(textOf(second, "sc.line1"), "9800");
  // The same template, unchanged apart from the binding, follows the business.
  assert.equal(second.placements.find((p) => p.fieldId === "sc.method.accrual")?.text, "X");
  assert.equal(second.placements.find((p) => p.fieldId === "sc.method.cash"), undefined);
});

test("prints one row per item and gives every placement a distinct id", () => {
  const plan = buildPlan(scheduleC, data);
  const ids = plan.placements.map((p) => p.fieldId);
  assert.equal(new Set(ids).size, ids.length, "placement ids must be unique");

  assert.equal(textOf(plan, "sc.partII.expenses[0].category"), "Advertising");
  assert.equal(textOf(plan, "sc.partII.expenses[0].amount"), "4200.00");
  assert.equal(textOf(plan, "sc.partII.expenses[7].category"), "Rent — vehicles and equipment");
});

test("collapses the rows that do not fit and reports them on a statement", () => {
  const plan = buildPlan(scheduleC, data);

  // The form provides 9 rows for 12 expenses: 8 print, 4 are carried over.
  assert.equal(plan.placements.filter((p) => /expenses\[\d+\]\.category$/.test(p.fieldId)).length, 8);
  assert.equal(textOf(plan, "sc.partII.expenses.overflow.amount"), "34146.75");
  assert.match(String(textOf(plan, "sc.partII.expenses.overflow.category")), /^See attached:/);

  assert.equal(plan.statements.length, 1);
  const [statement] = plan.statements;
  assert.equal(statement.sourceEntryId, "sc.partII.expenses");
  assert.deepEqual(statement.columns, ["Category", "Amount"]);
  assert.equal(statement.rows.length, 4);
  assert.deepEqual(statement.rows[0], ["Rent — other business property", "24000.00"]);

  // Nothing may be lost: the printed rows plus the carried total must equal
  // the figure the form itself reports on line 28.
  const printed = plan.placements
    .filter((p) => /expenses\[\d+\]\.amount$/.test(p.fieldId))
    .reduce((sum, p) => sum + Number(p.text), 0);
  const carried = Number(textOf(plan, "sc.partII.expenses.overflow.amount"));
  assert.equal((printed + carried).toFixed(2), "85213.05");
});

test("reports rather than throws when a row cannot be evaluated", () => {
  const broken = structuredClone(scheduleC);
  const repeat = broken.entries.find((e) => e.kind === "repeat") as any;
  repeat.row.fields[1].value = { ref: "@.category", aggregate: "sum" };

  const plan = buildPlan(broken, data);
  assert.ok(plan.diagnostics.length > 0);
  assert.ok(plan.diagnostics.every((d) => d.code === "value/not-numeric"));
});

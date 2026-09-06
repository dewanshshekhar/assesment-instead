import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";
import { CASES, path, planFor, readGolden, serialise } from "../src/conformance.ts";

const planSchema = JSON.parse(await readFile(path("spec/render-plan.schema.json"), "utf8"));
const validatePlan = new Ajv2020({ allErrors: true, strict: false }).compile(planSchema);

for (const testCase of CASES) {
  test(`${testCase.name}: the compiled plan matches its golden`, async () => {
    const actual = serialise(await planFor(testCase));
    const expected = await readGolden(testCase);

    assert.equal(
      actual,
      expected,
      `the render plan changed. If that is intended, run 'npm run conformance:update' and review the diff — ` +
        `every consumer draws from this contract.`,
    );
  });

  test(`${testCase.name}: the golden plan satisfies the plan schema`, async () => {
    const golden = JSON.parse(await readGolden(testCase));
    assert.ok(
      validatePlan(golden),
      `schema errors: ${JSON.stringify(validatePlan.errors, null, 2)}`,
    );
  });

  test(`${testCase.name}: every placement is self-contained`, async () => {
    const plan = await planFor(testCase);

    // A consumer holding only the plan must never have to fall back on a
    // default of its own, so no presentation property may be absent.
    const required = [
      "fieldId", "page", "rect", "text", "font", "size", "color",
      "align", "vAlign", "padding", "overflow", "minSize", "lineHeight",
    ];

    for (const placement of plan.placements) {
      for (const key of required) {
        assert.notEqual(
          (placement as Record<string, unknown>)[key],
          undefined,
          `${placement.fieldId} is missing '${key}'`,
        );
      }
      for (const side of ["top", "right", "bottom", "left"]) {
        assert.equal(
          typeof (placement.padding as Record<string, unknown>)[side],
          "number",
          `${placement.fieldId} has no resolved '${side}' padding`,
        );
      }
    }
  });

  test(`${testCase.name}: plan version is pinned independently of the template`, async () => {
    const plan = await planFor(testCase);
    assert.match(plan.planVersion, /^\d+\.\d+\.\d+$/);
    assert.ok(plan.source.sha256.length === 64);
    assert.ok(plan.geometry.pages.length >= 1);
  });
}

test("checkbox placements carry zero padding, so the glyph keeps its full box", async () => {
  const plan = await planFor(CASES[0]);
  const checkboxes = plan.placements.filter((p) => p.fieldId.startsWith("p1.status."));

  assert.ok(checkboxes.length > 0);
  for (const box of checkboxes) {
    assert.deepEqual(box.padding, { top: 0, right: 0, bottom: 0, left: 0 });
  }
});

test("text placements keep the padding the template asked for", async () => {
  const plan = await planFor(CASES[0]);
  const line = plan.placements.find((p) => p.fieldId === "p1.line1a");

  assert.deepEqual(line?.padding, { top: 0, right: 4, bottom: 0, left: 3 });
});

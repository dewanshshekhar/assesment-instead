import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { RenderPlan } from "../../spec/types.ts";
import { CASES, path, planFor } from "../src/conformance.ts";
import { render, appendStatements, sha256 } from "../src/render.ts";

const scheduleC = CASES[1];
const sourcePdf = async () =>
  new Uint8Array(await readFile(path("tools/fixtures/schedule-c.pdf")));

/** What a third-party consumer actually receives: JSON, not an object graph. */
const roundTrip = (plan: RenderPlan): RenderPlan => JSON.parse(JSON.stringify(plan));

test("a plan that has been through JSON draws exactly the same bytes", async () => {
  const plan = await planFor(scheduleC);
  const source = await sourcePdf();

  const direct = await render(plan, source);
  const viaJson = await render(roundTrip(plan), source);

  assert.deepEqual(direct.diagnostics, []);
  assert.deepEqual(
    sha256(direct.pdf),
    sha256(viaJson.pdf),
    "a serialised plan must be sufficient on its own",
  );
});

test("rendering the same plan twice is byte-reproducible", async () => {
  const plan = await planFor(scheduleC);
  const source = await sourcePdf();

  const first = await render(plan, source);
  const second = await render(plan, source);

  assert.equal(sha256(first.pdf), sha256(second.pdf));
  assert.equal(
    sha256(await appendStatements(first.pdf, plan)),
    sha256(await appendStatements(second.pdf, plan)),
  );
});

test("refuses to draw onto a PDF the plan was not measured against", async () => {
  const plan = await planFor(scheduleC);
  const wrongForm = new Uint8Array(await readFile(path("tools/fixtures/f1040-p1.pdf")));

  const result = await render(plan, wrongForm);
  const mismatch = result.diagnostics.find((d) => d.code === "source/digest-mismatch");

  assert.ok(mismatch, "the digest mismatch must be reported");
  assert.equal(mismatch.severity, "error");
  // Nothing may be drawn onto the wrong form.
  assert.equal(sha256(result.pdf), sha256(wrongForm));
});

test("a mismatch can be downgraded to a warning, but never passes silently", async () => {
  const plan = await planFor(scheduleC);
  const wrongForm = new Uint8Array(await readFile(path("tools/fixtures/f1040-p1.pdf")));

  const result = await render(plan, wrongForm, { enforceDigest: false });
  const mismatch = result.diagnostics.find((d) => d.code === "source/digest-mismatch");

  assert.equal(mismatch?.severity, "warning");
  assert.notEqual(sha256(result.pdf), sha256(wrongForm), "it should have drawn this time");
});

test("overflow policy travels on the placement, not in the renderer", async () => {
  const plan = await planFor(scheduleC);
  const source = await sourcePdf();

  // Widen a value past its box and let the plan's own policy decide.
  const failing = roundTrip(plan);
  const target = failing.placements.find((p) => p.fieldId === "sc.businessName")!;
  target.text = "A".repeat(400);
  target.overflow = "error";

  const errored = await render(failing, source);
  assert.ok(errored.diagnostics.some((d) => d.code === "layout/overflow"));

  const shrinking = roundTrip(plan);
  const same = shrinking.placements.find((p) => p.fieldId === "sc.businessName")!;
  same.text = "A".repeat(400);
  same.overflow = "shrink";

  const shrunk = await render(shrinking, source);
  assert.ok(!shrunk.diagnostics.some((d) => d.code === "layout/overflow"));
});

test("the renderer does not depend on templates at all", async () => {
  const source = await readFile(path("tools/src/render.ts"), "utf8");

  // A regression here would quietly reintroduce the coupling that makes the
  // plan insufficient for a third-party consumer.
  for (const forbidden of ["AnnotationTemplate", "./plan.ts", "./reference.ts", "./value.ts", "./format.ts"]) {
    assert.ok(
      !source.includes(forbidden),
      `render.ts must not reference ${forbidden}; the plan is meant to be the only input`,
    );
  }
});

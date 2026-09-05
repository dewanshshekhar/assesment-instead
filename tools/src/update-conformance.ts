#!/usr/bin/env node
/**
 * Regenerates the golden render plans.
 *
 * Run this deliberately, and read the diff: a change here is a change to the
 * contract every consumer draws from.
 */

import { writeFile } from "node:fs/promises";
import { CASES, path, planFor, serialise } from "./conformance.ts";

for (const testCase of CASES) {
  const plan = await planFor(testCase);
  await writeFile(path(testCase.golden), serialise(plan));
  process.stdout.write(
    `${testCase.golden}  ${plan.placements.length} placement(s), ${plan.statements.length} statement(s)\n`,
  );
}

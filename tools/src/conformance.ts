/**
 * Golden render plans.
 *
 * A plan is the contract between a template and whoever draws it, so the
 * contract is pinned to committed files. Any change to resolution,
 * formatting or geometry shows up as a diff in review rather than as a
 * silently different tax form.
 *
 * The same files are what a third-party implementation compares itself
 * against: plans carry no font metrics, so agreement can be exact.
 */

import { readFile } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import type { AnnotationTemplate, RenderPlan } from "../../spec/types.ts";
import { buildPlan } from "./plan.ts";
import type { Json } from "./reference.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolvePath(HERE, "../..");

export interface Case {
  name: string;
  template: string;
  data: string;
  golden: string;
}

export const CASES: Case[] = [
  {
    name: "us.irs.f1040.2025",
    template: "templates/us.irs.f1040.2025.json",
    data: "examples/sample-return.json",
    golden: "conformance/plans/us.irs.f1040.2025.plan.json",
  },
  {
    name: "us.irs.f1040.2024",
    template: "templates/us.irs.f1040.2024.json",
    data: "examples/sample-return.json",
    golden: "conformance/plans/us.irs.f1040.2024.plan.json",
  },
  {
    name: "us.irs.f1040sc.2024",
    template: "templates/us.irs.f1040sc.2024.json",
    data: "examples/sample-return.json",
    golden: "conformance/plans/us.irs.f1040sc.2024.plan.json",
  },
];

export const path = (relative: string): string => resolvePath(ROOT, relative);

/** Look cases up by name; indexes shift whenever a template is added. */
export function caseNamed(name: string): Case {
  const found = CASES.find((c) => c.name === name);
  if (!found) throw new Error(`no conformance case named '${name}'`);
  return found;
}

const readJson = async <T,>(relative: string): Promise<T> =>
  JSON.parse(await readFile(path(relative), "utf8")) as T;

export async function planFor(testCase: Case): Promise<RenderPlan> {
  const template = await readJson<AnnotationTemplate>(testCase.template);
  const data = await readJson<Json>(testCase.data);
  return buildPlan(template, data);
}

/** Canonical on-disk form, so that a diff is meaningful. */
export function serialise(plan: RenderPlan): string {
  return `${JSON.stringify(plan, null, 2)}\n`;
}

export async function readGolden(testCase: Case): Promise<string> {
  return readFile(path(testCase.golden), "utf8");
}

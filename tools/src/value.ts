/**
 * Value evaluation: reference -> aggregate -> transform -> fallback -> default.
 *
 * Resolution is separated from formatting so that a host application can
 * reuse this stage and format with its own locale rules.
 */

import { resolve, type Json, type ResolutionContext } from "./reference.ts";

export type Aggregate = "sum" | "count" | "first" | "last" | "min" | "max" | "join";
export type Transform = "digitsOnly" | "upper" | "lower" | "trim" | "abs" | "negate";

export interface ValueSpec {
  ref?: string;
  const?: string | number | boolean;
  aggregate?: Aggregate;
  separator?: string;
  transform?: Transform[];
  fallback?: string[];
  default?: string | number | boolean | null;
  equals?: string | number | boolean;
}

export interface Evaluation {
  /** undefined means "nothing was selected and no default applied". */
  value: Json | undefined;
  /** True when the primary reference and every fallback selected nothing. */
  missing: boolean;
}

export class EvaluationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "EvaluationError";
    this.code = code;
  }
}

export function evaluate(spec: ValueSpec, ctx: ResolutionContext): Evaluation {
  if (spec.const !== undefined) {
    return { value: applyTransforms(spec.const, spec.transform), missing: false };
  }
  if (spec.ref === undefined) {
    throw new EvaluationError("value/empty", "value must declare either 'ref' or 'const'");
  }

  const refs = [spec.ref, ...(spec.fallback ?? [])];
  for (const ref of refs) {
    const nodes = resolve(ref, ctx);
    if (nodes.length === 0) continue;

    const collapsed = collapse(ref, nodes, spec);
    if (collapsed === undefined || collapsed === null) continue;
    return { value: applyTransforms(collapsed, spec.transform), missing: false };
  }

  if (spec.default !== undefined) {
    return { value: applyTransforms(spec.default, spec.transform), missing: true };
  }
  return { value: undefined, missing: true };
}

function collapse(ref: string, nodes: Json[], spec: ValueSpec): Json | undefined {
  if (spec.aggregate === undefined) {
    if (nodes.length > 1) {
      // Silently taking the first node here is how wrong numbers reach a
      // filed return, so a multi-valued reference must say what it means.
      throw new EvaluationError(
        "value/ambiguous",
        `reference ${JSON.stringify(ref)} selected ${nodes.length} nodes but declares no 'aggregate'`,
      );
    }
    return nodes[0];
  }

  switch (spec.aggregate) {
    case "count":
      return nodes.length;
    case "first":
      return nodes[0];
    case "last":
      return nodes[nodes.length - 1];
    case "join":
      return nodes.map((n) => stringify(n)).join(spec.separator ?? ", ");
    case "sum":
      return numbers(ref, nodes).reduce((a, b) => a + b, 0);
    case "min":
      return Math.min(...numbers(ref, nodes));
    case "max":
      return Math.max(...numbers(ref, nodes));
  }
}

function numbers(ref: string, nodes: Json[]): number[] {
  return nodes.map((n) => {
    const v = typeof n === "string" ? Number(n) : n;
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new EvaluationError(
        "value/not-numeric",
        `reference ${JSON.stringify(ref)} selected a non-numeric node under a numeric aggregate`,
      );
    }
    return v;
  });
}

function applyTransforms(value: Json, transforms: Transform[] | undefined): Json {
  let out = value;
  for (const t of transforms ?? []) {
    switch (t) {
      case "digitsOnly":
        out = stringify(out).replace(/\D+/g, "");
        break;
      case "upper":
        out = stringify(out).toUpperCase();
        break;
      case "lower":
        out = stringify(out).toLowerCase();
        break;
      case "trim":
        out = stringify(out).trim();
        break;
      case "abs":
        out = Math.abs(asNumber(out, "abs"));
        break;
      case "negate":
        out = -asNumber(out, "negate");
        break;
    }
  }
  return out;
}

function asNumber(v: Json, transform: string): number {
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) {
    throw new EvaluationError("value/not-numeric", `transform '${transform}' requires a number`);
  }
  return n;
}

function stringify(v: Json): string {
  if (v === null) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** Checkbox predicate: `equals` when given, otherwise plain truthiness. */
export function isChecked(spec: ValueSpec, evaluation: Evaluation): boolean {
  if (evaluation.value === undefined) return false;
  if (spec.equals !== undefined) return evaluation.value === spec.equals;
  return Boolean(evaluation.value);
}

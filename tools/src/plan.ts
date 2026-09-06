/**
 * Builds a RenderPlan: every value resolved, formatted and placed, with no
 * font metrics involved.
 *
 * The split matters. A host application has its own fonts, and its metrics
 * will not match this one's, so the plan stops at "this string goes in this
 * box with this alignment" and leaves fitting to the drawing stage. That is
 * the seam at which a third party plugs in their own renderer.
 */

import type {
  AnnotationTemplate,
  Condition,
  ContinuationStatement,
  Diagnostic,
  Entry,
  Field,
  Format,
  PlacedText,
  RenderPlan,
  Style,
} from "../../spec/types.ts";
import { resolve, type Json } from "./reference.ts";
import { evaluate, isChecked, EvaluationError, type ValueSpec } from "./value.ts";
import { formatValue, splitCents } from "./format.ts";
import { combCells, translate, type Rect } from "./layout.ts";

const STYLE_FALLBACK: Required<Pick<Style, "font" | "size" | "color" | "align" | "vAlign" | "overflow" | "minSize" | "glyph" | "lineHeight" | "letterSpacing">> = {
  font: "Helvetica",
  size: 10,
  color: "#000000",
  align: "left",
  vAlign: "middle",
  overflow: "error",
  minSize: 6,
  glyph: "X",
  lineHeight: 1.15,
  letterSpacing: 0,
};

export function buildPlan(template: AnnotationTemplate, data: Json): RenderPlan {
  const placements: PlacedText[] = [];
  const statements: ContinuationStatement[] = [];
  const diagnostics: Diagnostic[] = [];

  const binding = resolveBinding(template, data, diagnostics);

  for (const entry of template.entries) {
    try {
      if (entry.kind === "field") {
        placeField(entry, entry.page, [0, 0], template, data, binding, placements);
      } else {
        placeRepeat(entry, template, data, binding, placements, statements, diagnostics);
      }
    } catch (error) {
      diagnostics.push(toDiagnostic(entry.id, error));
    }
  }

  return { templateId: template.template.id, placements, statements, diagnostics };
}

function resolveBinding(template: AnnotationTemplate, data: Json, diagnostics: Diagnostic[]): Json {
  const root = template.bind?.root;
  if (!root) return data;

  const nodes = resolve(root, { root: data });
  if (nodes.length === 0) {
    diagnostics.push({
      severity: "warning",
      code: "bind/unresolved",
      message: `bind.root ${JSON.stringify(root)} selected nothing; '@' references will resolve against the document root`,
    });
    return data;
  }
  return nodes[0];
}

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

function placeField(
  field: Field | Omit<Field, "page">,
  page: number,
  offset: [number, number],
  template: AnnotationTemplate,
  data: Json,
  current: Json,
  out: PlacedText[],
  /** Qualified id, so that a row's placements stay distinguishable. */
  fieldId: string = field.id,
): void {
  const ctx = { root: data, current };

  if (field.visibleWhen && !conditionHolds(field.visibleWhen, ctx)) return;

  const style = { ...STYLE_FALLBACK, ...template.defaults?.style, ...field.style };
  const format: Format = { ...template.defaults?.format, ...field.format };
  const rect = translate(field.rect as Rect, offset[0], offset[1]);
  const value = field.value as ValueSpec;

  if (field.type === "checkbox") {
    if (!isChecked(value, evaluate(value, ctx))) return;
    out.push(base(fieldId, page, rect, style.glyph, style));
    return;
  }

  const evaluation = evaluate(value, ctx);
  if (evaluation.missing && format.blankIfNull !== false && evaluation.value === undefined) return;

  const text = formatValue(field.type, evaluation.value, format);
  if (text === "") return;

  if (field.type === "comb") {
    if (!field.comb) {
      throw new EvaluationError("comb/missing-spec", `field '${fieldId}' is type 'comb' but has no 'comb' block`);
    }
    const placement = base(fieldId, page, rect, text, style);
    placement.cells = combCells(rect, field.comb, text);
    out.push(placement);
    return;
  }

  if (field.type === "currency" && field.cents) {
    const { dollars, cents } = splitCents(text);
    out.push(base(fieldId, page, rect, dollars, style));
    const centsStyle = { ...style, ...field.cents.style };
    out.push(base(`${fieldId}#cents`, page, field.cents.rect as Rect, cents, centsStyle));
    return;
  }

  out.push(base(fieldId, page, rect, text, style));
}

function base(
  fieldId: string,
  page: number,
  rect: Rect,
  text: string,
  style: typeof STYLE_FALLBACK & Style,
): PlacedText {
  return {
    fieldId,
    page,
    rect,
    text,
    font: style.font,
    size: style.size,
    color: style.color,
    align: style.align,
  };
}

// ---------------------------------------------------------------------------
// Repeat groups
// ---------------------------------------------------------------------------

function placeRepeat(
  group: Extract<Entry, { kind: "repeat" }>,
  template: AnnotationTemplate,
  data: Json,
  binding: Json,
  out: PlacedText[],
  statements: ContinuationStatement[],
  diagnostics: Diagnostic[],
): void {
  const nodes = resolve(group.over, { root: data, current: binding });
  const items = nodes.length === 1 && Array.isArray(nodes[0]) ? (nodes[0] as Json[]) : nodes;

  const overflow = group.overflow ?? "error";
  let visible = items;
  let spilled: Json[] = [];

  if (items.length > group.maxRows) {
    if (overflow === "error") {
      diagnostics.push({
        severity: "error",
        code: "repeat/overflow",
        entryId: group.id,
        message: `${items.length} items exceed the ${group.maxRows} rows the form provides`,
      });
      return;
    }
    if (overflow === "truncate") {
      visible = items.slice(0, group.maxRows);
    } else {
      // Leave the last printed row for the collapsed remainder, which is how
      // the form itself expects an attached statement to be summarised.
      visible = items.slice(0, group.maxRows - 1);
      spilled = items.slice(group.maxRows - 1);
    }
  }

  visible.forEach((item, rowIndex) => {
    const dy = group.origin[1] + rowIndex * group.rowHeight;
    for (const rowField of group.row.fields) {
      try {
        placeField(
          rowField,
          group.page,
          [group.origin[0], dy],
          template,
          data,
          item,
          out,
          `${group.id}[${rowIndex}].${rowField.id}`,
        );
      } catch (error) {
        diagnostics.push(toDiagnostic(`${group.id}[${rowIndex}].${rowField.id}`, error));
      }
    }
  });

  if (spilled.length > 0 && group.continuation) {
    statements.push(buildStatement(group, spilled, data, diagnostics));

    const dy = group.origin[1] + visible.length * group.rowHeight;
    for (const rowField of group.row.fields) {
      const summary = summariseSpill(rowField, spilled, data, group.continuation.title);
      if (summary === undefined) continue;
      const style = { ...STYLE_FALLBACK, ...template.defaults?.style, ...rowField.style };
      const rect = translate(rowField.rect as Rect, group.origin[0], dy);
      out.push(base(`${group.id}.overflow.${rowField.id}`, group.page, rect, summary, style));
    }
  }
}

/**
 * The spilled rows still have to be reported. Numeric columns collapse to
 * their total so the form's own arithmetic stays correct; the first text
 * column carries the pointer to the attachment.
 */
function summariseSpill(
  rowField: Omit<Field, "page">,
  spilled: Json[],
  data: Json,
  title: string,
): string | undefined {
  if (rowField.type === "currency" || rowField.type === "number") {
    let total = 0;
    for (const item of spilled) {
      const evaluation = evaluate(rowField.value as ValueSpec, { root: data, current: item });
      const n = Number(evaluation.value ?? 0);
      if (Number.isFinite(n)) total += n;
    }
    return formatValue(rowField.type, total, (rowField.format ?? {}) as Format);
  }
  if (rowField.type === "text" || rowField.type === "multilineText") {
    return `See attached: ${title}`;
  }
  return undefined;
}

function buildStatement(
  group: Extract<Entry, { kind: "repeat" }>,
  spilled: Json[],
  data: Json,
  diagnostics: Diagnostic[],
): ContinuationStatement {
  const columns = group.row.fields.map((f) => f.label ?? f.id);
  const rows = spilled.map((item) =>
    group.row.fields.map((f) => {
      try {
        const evaluation = evaluate(f.value as ValueSpec, { root: data, current: item });
        return formatValue(f.type, evaluation.value, (f.format ?? {}) as Format);
      } catch (error) {
        diagnostics.push(toDiagnostic(`${group.id}.statement.${f.id}`, error));
        return "";
      }
    }),
  );

  return {
    statementId: group.continuation!.statementId,
    title: group.continuation!.title,
    sourceEntryId: group.id,
    columns,
    rows,
  };
}

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------

export function conditionHolds(condition: Condition, ctx: { root: Json; current?: Json }): boolean {
  const nodes = resolve(condition.ref, ctx);
  const value = nodes[0];

  if (condition.exists !== undefined) return (nodes.length > 0) === condition.exists;
  if (condition.truthy !== undefined) return Boolean(value) === condition.truthy;
  if (condition.equals !== undefined) return value === condition.equals;
  if (condition.notEquals !== undefined) return value !== condition.notEquals;
  if (condition.gt !== undefined) return typeof value === "number" && value > condition.gt;
  if (condition.lt !== undefined) return typeof value === "number" && value < condition.lt;
  return nodes.length > 0;
}

function toDiagnostic(entryId: string, error: unknown): Diagnostic {
  const code = error instanceof EvaluationError ? error.code : "internal";
  return {
    severity: "error",
    code,
    entryId,
    message: error instanceof Error ? error.message : String(error),
  };
}

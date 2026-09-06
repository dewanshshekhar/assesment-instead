/**
 * Builds a RenderPlan: every value resolved, formatted, styled and placed.
 *
 * The plan is the compile target and it is self-contained by construction.
 * Every presentation property is merged from the template defaults here, so
 * that a consumer holding only the plan can draw a correct page and two
 * consumers cannot disagree about what an absent value meant.
 *
 * The single thing left undecided is fitting text to its box, because that
 * needs font metrics and those belong to whichever stack does the drawing.
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

export const PLAN_VERSION = "1.0.0";

type Padding = { top: number; right: number; bottom: number; left: number };

interface ResolvedStyle {
  font: string;
  size: number;
  color: string;
  align: "left" | "center" | "right";
  vAlign: "top" | "middle" | "bottom";
  padding: Padding;
  overflow: "error" | "shrink" | "truncate" | "ellipsis" | "wrap";
  minSize: number;
  lineHeight: number;
  glyph: string;
}

const STYLE_FALLBACK: Omit<ResolvedStyle, "padding"> = {
  font: "Helvetica",
  size: 10,
  color: "#000000",
  align: "left",
  vAlign: "middle",
  overflow: "error",
  minSize: 6,
  lineHeight: 1.15,
  glyph: "X",
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

  return {
    planVersion: PLAN_VERSION,
    templateId: template.template.id,
    templateRevision: template.template.revision,
    taxYear: template.template.taxYear,
    source: template.template.source,
    geometry: template.template.geometry,
    placements,
    statements,
    diagnostics,
  };
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
// Style resolution
// ---------------------------------------------------------------------------

function normalisePadding(padding: Style["padding"]): Padding {
  return {
    top: padding?.top ?? 0,
    right: padding?.right ?? 0,
    bottom: padding?.bottom ?? 0,
    left: padding?.left ?? 0,
  };
}

/**
 * Merges template defaults under a field's own style, one level deep, and
 * resolves every property to a concrete value.
 *
 * Padding insets a text box. A checkbox is a mark centred in the ruled square
 * itself, so inherited text padding must not shrink it: on a 10pt box a
 * default 3/4pt inset leaves no room for the glyph at all. Applying that rule
 * here rather than at draw time keeps it a property of the specification
 * instead of a quirk of one renderer.
 */
function resolveStyle(
  template: AnnotationTemplate,
  field: Field | Omit<Field, "page">,
  override?: Style,
): ResolvedStyle {
  const merged: Style = { ...template.defaults?.style, ...field.style, ...override };
  return {
    ...STYLE_FALLBACK,
    ...stripUndefined(merged),
    padding: field.type === "checkbox" ? normalisePadding({}) : normalisePadding(merged.padding),
  } as ResolvedStyle;
}

function stripUndefined(style: Style): Partial<ResolvedStyle> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(style)) {
    if (value !== undefined && key !== "padding") out[key] = value;
  }
  return out as Partial<ResolvedStyle>;
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

  const style = resolveStyle(template, field);
  const format: Format = { ...template.defaults?.format, ...field.format };
  const rect = translate(field.rect as Rect, offset[0], offset[1]);
  const value = field.value as ValueSpec;

  if (field.type === "checkbox") {
    if (!isChecked(value, evaluate(value, ctx))) return;
    out.push(place(fieldId, page, rect, style.glyph, style));
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
    if (text.length > field.comb.cells) {
      throw new EvaluationError(
        "comb/too-long",
        `field '${fieldId}' has ${field.comb.cells} cells but the value is ${text.length} characters`,
      );
    }
    const placement = place(fieldId, page, rect, text, style);
    placement.cells = combCells(rect, field.comb, text);
    out.push(placement);
    return;
  }

  if (field.type === "currency" && field.cents) {
    const { dollars, cents } = splitCents(text);
    out.push(place(fieldId, page, rect, dollars, style));
    const centsStyle = resolveStyle(template, field, field.cents.style);
    out.push(place(`${fieldId}#cents`, page, field.cents.rect as Rect, cents, centsStyle));
    return;
  }

  out.push(place(fieldId, page, rect, text, style));
}

function place(
  fieldId: string,
  page: number,
  rect: Rect,
  text: string,
  style: ResolvedStyle,
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
    vAlign: style.vAlign,
    padding: { ...style.padding },
    overflow: style.overflow,
    minSize: style.minSize,
    lineHeight: style.lineHeight,
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
      const style = resolveStyle(template, rowField);
      const rect = translate(rowField.rect as Rect, group.origin[0], dy);
      out.push(place(`${group.id}.overflow.${rowField.id}`, group.page, rect, summary, style));
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

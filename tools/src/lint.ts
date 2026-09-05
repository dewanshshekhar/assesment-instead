/**
 * Static checks on a template, plus optional checks against a sample data set.
 *
 * The point is to catch a broken template at authoring time rather than on a
 * filed return: a box off the page, a reference that selects two nodes with
 * no aggregate, a comb whose cells cannot fit.
 */

// The default Ajv build targets draft-07; the schema is draft 2020-12.
import Ajv2020 from "ajv/dist/2020.js";
import type { AnnotationTemplate, Diagnostic, Field } from "../../spec/types.ts";
import { parseReference, resolve, ReferenceSyntaxError, type Json } from "./reference.ts";
import { buildPlan } from "./plan.ts";
import type { Rect } from "./layout.ts";

export interface LintOptions {
  /** When given, references are also resolved against it and a plan is built. */
  data?: Json;
  schema?: unknown;
}

export function lint(template: AnnotationTemplate, options: LintOptions = {}): Diagnostic[] {
  const out: Diagnostic[] = [];

  if (options.schema) {
    out.push(...validateSchema(template, options.schema));
    // A document that fails the schema cannot be reasoned about further.
    if (out.some((d) => d.severity === "error")) return out;
  }

  checkIdentifiers(template, out);
  checkGeometry(template, out);
  checkReferences(template, out);
  checkCombs(template, out);
  checkRadioGroups(template, out);
  checkOverlaps(template, out);

  if (options.data !== undefined) {
    checkAgainstData(template, options.data, out);
  }

  return out;
}

function validateSchema(template: AnnotationTemplate, schema: unknown): Diagnostic[] {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validate = ajv.compile(schema as object);
  if (validate(template)) return [];

  return (validate.errors ?? []).map((error) => ({
    severity: "error" as const,
    code: "schema/invalid",
    message: `${error.instancePath || "/"} ${error.message ?? "failed validation"}`,
  }));
}

interface FieldRef {
  field: Field | Omit<Field, "page">;
  page: number;
  path: string;
  /** True for a field inside a repeat row, whose '@' refs bind to an item. */
  inRepeat: boolean;
}

function eachField(template: AnnotationTemplate): FieldRef[] {
  const out: FieldRef[] = [];
  for (const entry of template.entries) {
    if (entry.kind === "field") {
      out.push({ field: entry, page: entry.page, path: entry.id, inRepeat: false });
    } else {
      for (const rowField of entry.row.fields) {
        out.push({
          field: rowField,
          page: entry.page,
          path: `${entry.id}.${rowField.id}`,
          inRepeat: true,
        });
      }
    }
  }
  return out;
}

function checkIdentifiers(template: AnnotationTemplate, out: Diagnostic[]): void {
  const seen = new Set<string>();
  for (const entry of template.entries) {
    if (seen.has(entry.id)) {
      out.push({ severity: "error", code: "id/duplicate", entryId: entry.id, message: "duplicate entry id" });
    }
    seen.add(entry.id);

    if (entry.kind === "repeat") {
      const rowIds = new Set<string>();
      for (const f of entry.row.fields) {
        if (rowIds.has(f.id)) {
          out.push({
            severity: "error",
            code: "id/duplicate",
            entryId: `${entry.id}.${f.id}`,
            message: "duplicate field id within a repeat row",
          });
        }
        rowIds.add(f.id);
      }
    }
  }
}

function checkGeometry(template: AnnotationTemplate, out: Diagnostic[]): void {
  const pages = template.template.geometry.pages;

  for (const { field, page, path } of eachField(template)) {
    if (page >= pages.length) {
      out.push({
        severity: "error",
        code: "page/out-of-range",
        entryId: path,
        message: `page ${page} but the template declares ${pages.length}`,
      });
      continue;
    }
  }

  for (const entry of template.entries) {
    const page = pages[entry.page];
    if (!page) continue;

    if (entry.kind === "field") {
      assertInside(entry.rect as Rect, page, entry.id, out);
      if (entry.cents) assertInside(entry.cents.rect as Rect, page, `${entry.id}#cents`, out);
    } else {
      const lastRowTop = entry.origin[1] + (entry.maxRows - 1) * entry.rowHeight;
      for (const f of entry.row.fields) {
        const first: Rect = [f.rect[0] + entry.origin[0], f.rect[1] + entry.origin[1], f.rect[2], f.rect[3]];
        const last: Rect = [f.rect[0] + entry.origin[0], f.rect[1] + lastRowTop, f.rect[2], f.rect[3]];
        assertInside(first, page, `${entry.id}.${f.id} (first row)`, out);
        assertInside(last, page, `${entry.id}.${f.id} (row ${entry.maxRows})`, out);
      }
    }
  }
}

function assertInside(
  rect: Rect,
  page: { width: number; height: number },
  entryId: string,
  out: Diagnostic[],
): void {
  const [x, y, w, h] = rect;
  if (x < 0 || y < 0 || x + w > page.width || y + h > page.height) {
    out.push({
      severity: "error",
      code: "rect/out-of-bounds",
      entryId,
      message: `rect [${rect.join(", ")}] falls outside the ${page.width}x${page.height}pt page`,
    });
  }
}

function checkReferences(template: AnnotationTemplate, out: Diagnostic[]): void {
  const check = (ref: string, entryId: string, requiresAggregate: boolean, hasAggregate: boolean) => {
    try {
      const parsed = parseReference(ref);
      if (requiresAggregate && parsed.multi && !hasAggregate) {
        out.push({
          severity: "error",
          code: "value/ambiguous",
          entryId,
          message: `${JSON.stringify(ref)} can select multiple nodes but no 'aggregate' is declared`,
        });
      }
    } catch (error) {
      out.push({
        severity: "error",
        code: "reference/syntax",
        entryId,
        message: error instanceof ReferenceSyntaxError ? error.message : String(error),
      });
    }
  };

  if (template.bind?.root) check(template.bind.root, "bind.root", false, false);

  for (const { field, path } of eachField(template)) {
    const value = field.value;
    const hasAggregate = value.aggregate !== undefined;
    if (value.ref) check(value.ref, path, true, hasAggregate);
    for (const fallback of value.fallback ?? []) check(fallback, path, true, hasAggregate);
    if (field.visibleWhen) check(field.visibleWhen.ref, `${path}.visibleWhen`, false, false);
  }

  for (const entry of template.entries) {
    if (entry.kind === "repeat") check(entry.over, entry.id, false, false);
  }
}

function checkCombs(template: AnnotationTemplate, out: Diagnostic[]): void {
  for (const { field, path } of eachField(template)) {
    if (field.type !== "comb" || !field.comb) continue;

    const totalGap = Object.values(field.comb.gaps ?? {}).reduce((a, b) => a + b, 0);
    const cellWidth = (field.rect[2] - totalGap) / field.comb.cells;
    if (cellWidth <= 0) {
      out.push({
        severity: "error",
        code: "comb/no-room",
        entryId: path,
        message: `${field.comb.cells} cells plus ${totalGap}pt of gaps do not fit in ${field.rect[2]}pt`,
      });
    } else if (cellWidth < 4) {
      out.push({
        severity: "warning",
        code: "comb/narrow",
        entryId: path,
        message: `cell width is ${cellWidth.toFixed(2)}pt, which is unlikely to hold a digit`,
      });
    }

    for (const key of Object.keys(field.comb.gaps ?? {})) {
      if (Number(key) >= field.comb.cells) {
        out.push({
          severity: "warning",
          code: "comb/gap-past-end",
          entryId: path,
          message: `gap declared after cell ${key} but the comb has only ${field.comb.cells} cells`,
        });
      }
    }
  }
}

function checkRadioGroups(template: AnnotationTemplate, out: Diagnostic[]): void {
  const groups = new Map<string, string[]>();
  for (const { field, path } of eachField(template)) {
    if (!field.radioGroup) continue;
    const members = groups.get(field.radioGroup) ?? [];
    members.push(path);
    groups.set(field.radioGroup, members);
  }

  for (const [group, members] of groups) {
    if (members.length < 2) {
      out.push({
        severity: "warning",
        code: "radio/singleton",
        entryId: members[0],
        message: `radio group '${group}' has only one member`,
      });
    }
  }
}

function checkOverlaps(template: AnnotationTemplate, out: Diagnostic[]): void {
  const byPage = new Map<number, { id: string; rect: Rect }[]>();
  for (const entry of template.entries) {
    if (entry.kind !== "field") continue;
    const list = byPage.get(entry.page) ?? [];
    list.push({ id: entry.id, rect: entry.rect as Rect });
    if (entry.cents) list.push({ id: `${entry.id}#cents`, rect: entry.cents.rect as Rect });
    byPage.set(entry.page, list);
  }

  for (const [page, boxes] of byPage) {
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        if (intersects(boxes[i].rect, boxes[j].rect)) {
          out.push({
            severity: "warning",
            code: "rect/overlap",
            entryId: boxes[i].id,
            message: `overlaps '${boxes[j].id}' on page ${page}; one will print over the other`,
          });
        }
      }
    }
  }
}

function intersects(a: Rect, b: Rect): boolean {
  return a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
}

function checkAgainstData(template: AnnotationTemplate, data: Json, out: Diagnostic[]): void {
  const binding = template.bind?.root ? (resolve(template.bind.root, { root: data })[0] ?? data) : data;

  for (const { field, path, inRepeat } of eachField(template)) {
    const ref = field.value.ref;
    if (!ref || field.value.default !== undefined || (field.value.fallback ?? []).length > 0) continue;
    // A row field's '@' resolves against the current item, not against the
    // template binding, so it cannot be checked here; the plan diagnostics
    // appended below cover it instead.
    if (inRepeat && ref.startsWith("@")) continue;

    try {
      if (resolve(ref, { root: data, current: binding }).length === 0) {
        out.push({
          severity: "warning",
          code: "reference/unresolved",
          entryId: path,
          message: `${JSON.stringify(ref)} selects nothing in the sample data`,
        });
      }
    } catch {
      // Syntax problems are already reported by checkReferences.
    }
  }

  out.push(...buildPlan(template, data).diagnostics);
}

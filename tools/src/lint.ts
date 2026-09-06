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
import type { ValueSpec } from "./value.ts";
import type { Rect } from "./layout.ts";

export interface LintOptions {
  /** When given, references are also resolved against it and a plan is built. */
  data?: Json;
  schema?: unknown;
  /** Concept bindings overriding the template's own, as at render time. */
  bindings?: Record<string, ValueSpec>;
  /**
   * Report references that select nothing in `data`.
   *
   * Off by default. On a tax form an absent value is the normal case — a
   * complete template binds every line and any one return uses a handful — so
   * this only means something when `data` is a fixture chosen to exercise
   * every field. Left on, it cries wolf and trains an author to ignore it.
   */
  strictData?: boolean;
}

export function lint(template: AnnotationTemplate, options: LintOptions = {}): Diagnostic[] {
  const out: Diagnostic[] = [];

  if (options.schema) {
    out.push(...validateSchema(template, options.schema));
    // A document that fails the schema cannot be reasoned about further.
    if (out.some((d) => d.severity === "error")) return out;
  }

  const bindings = { ...template.bindings, ...options.bindings };

  checkIdentifiers(template, out);
  checkBindings(template, bindings, out);
  checkGeometry(template, out);
  checkReferences(template, out);
  checkCombs(template, out);
  checkRadioGroups(template, out);
  checkOverlaps(template, out);

  if (options.data !== undefined) {
    checkAgainstData(template, options.data, bindings, options.strictData ?? false, out);
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
      for (const itemField of entry.item.fields) {
        out.push({
          field: itemField,
          page: entry.page,
          path: `${entry.id}.${itemField.id}`,
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
      const itemIds = new Set<string>();
      for (const f of entry.item.fields) {
        if (itemIds.has(f.id)) {
          out.push({
            severity: "error",
            code: "id/duplicate",
            entryId: `${entry.id}.${f.id}`,
            message: "duplicate field id within a repeat item",
          });
        }
        itemIds.add(f.id);
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
      // The first and last slots bound every slot between them.
      const lastX = entry.origin[0] + (entry.capacity - 1) * entry.step[0];
      const lastY = entry.origin[1] + (entry.capacity - 1) * entry.step[1];
      for (const f of entry.item.fields) {
        const first: Rect = [f.rect[0] + entry.origin[0], f.rect[1] + entry.origin[1], f.rect[2], f.rect[3]];
        const last: Rect = [f.rect[0] + lastX, f.rect[1] + lastY, f.rect[2], f.rect[3]];
        assertInside(first, page, `${entry.id}.${f.id} (item 1)`, out);
        assertInside(last, page, `${entry.id}.${f.id} (item ${entry.capacity})`, out);
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

/**
 * A concept a field names must be bound, and a binding nobody names is dead
 * weight that will quietly rot. Both are worth saying at authoring time.
 */
function checkBindings(
  template: AnnotationTemplate,
  bindings: Record<string, ValueSpec>,
  out: Diagnostic[],
): void {
  const used = new Set<string>();

  const conceptsUsed: [string, string][] = [];
  for (const { field, path } of eachField(template)) {
    const c = (field.value as ValueSpec).concept;
    if (c !== undefined) conceptsUsed.push([c, path]);
  }
  for (const entry of template.entries) {
    if (entry.kind === "repeat" && !/^[$@/]/.test(entry.over)) conceptsUsed.push([entry.over, entry.id]);
  }
  if (template.bind?.root && !/^[$@/]/.test(template.bind.root)) {
    conceptsUsed.push([template.bind.root, "bind.root"]);
  }

  for (const [concept, path] of conceptsUsed) {
    used.add(concept);

    if (!bindings[concept]) {
      out.push({
        severity: "error",
        code: "binding/unbound",
        entryId: path,
        message: `concept '${concept}' is not defined by any binding`,
      });
    }
  }

  for (const concept of Object.keys(bindings)) {
    if (!used.has(concept)) {
      out.push({
        severity: "warning",
        code: "binding/unused",
        entryId: `bindings.${concept}`,
        message: `binding '${concept}' is never used by this template`,
      });
    }
  }

  if (Object.keys(bindings).length > 0 && !template.model) {
    out.push({
      severity: "warning",
      code: "binding/no-model",
      message: "the template uses concepts but declares no `model`, so nothing says which vocabulary they come from",
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

  if (template.bind?.root && /^[$@/]/.test(template.bind.root)) {
    check(template.bind.root, "bind.root", false, false);
  }

  // A binding's reference is a reference like any other, and a mistake in one
  // is worse: it is shared by every field that names the concept.
  //
  // The one exception is the binding `bind.root` names. Selecting the subject
  // of a form instance is a filter by nature, and SPEC 5.4 already defines
  // what a multi-valued root means, so demanding an aggregate there would be
  // asking an author to restate a rule the specification has settled.
  const rootConcept = template.bind?.root;
  for (const [concept, spec] of Object.entries(template.bindings ?? {})) {
    const isRoot = concept === rootConcept;
    if (spec.ref) check(spec.ref, `bindings.${concept}`, !isRoot, spec.aggregate !== undefined);
    for (const fallback of spec.fallback ?? []) {
      check(fallback, `bindings.${concept}`, !isRoot, spec.aggregate !== undefined);
    }
  }

  for (const { field, path } of eachField(template)) {
    const value = field.value;
    const hasAggregate = value.aggregate !== undefined;
    if (value.ref) check(value.ref, path, true, hasAggregate);
    for (const fallback of value.fallback ?? []) check(fallback, path, true, hasAggregate);
    if (field.visibleWhen) check(field.visibleWhen.ref, `${path}.visibleWhen`, false, false);
  }

  for (const entry of template.entries) {
    // A concept is checked by checkBindings; only a literal reference is
    // parsed here.
    if (entry.kind === "repeat" && /^[$@/]/.test(entry.over)) {
      check(entry.over, entry.id, false, false);
    }
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

function checkAgainstData(
  template: AnnotationTemplate,
  data: Json,
  bindings: Record<string, ValueSpec>,
  strictData: boolean,
  out: Diagnostic[],
): void {
  const declaredRoot = template.bind?.root;
  const rootRef = declaredRoot && (/^[$@/]/.test(declaredRoot) ? declaredRoot : bindings[declaredRoot]?.ref);
  const binding = rootRef ? (resolve(rootRef, { root: data })[0] ?? data) : data;

  // The plan's own diagnostics are always reported; the per-reference sweep
  // below is the opt-in part.
  out.push(...buildPlan(template, data, { bindings }).diagnostics);
  if (!strictData) return;

  for (const { field, path, inRepeat } of eachField(template)) {
    const spec = field.value.concept ? bindings[field.value.concept] : field.value;
    const ref = spec?.ref;
    if (spec === undefined) continue;
    if (!ref || spec.default !== undefined || (spec.fallback ?? []).length > 0) continue;
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

}

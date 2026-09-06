/**
 * Tax Form Annotation Specification (TFAS) v1.0.0
 *
 * A declarative, language-agnostic description of where and how to print
 * values onto a fixed-layout U.S. tax form.
 *
 * These types are normative: a conforming implementation in any language
 * MUST accept every document that satisfies them, and MUST reject documents
 * that do not. The JSON Schema in `annotation-template.schema.json` is the
 * machine-checkable form of the same model.
 */

/** Semantic version of the specification a document conforms to. */
export type SpecVersion = `${number}.${number}.${number}`;

// ---------------------------------------------------------------------------
// Document root
// ---------------------------------------------------------------------------

export interface AnnotationTemplate {
  /** Free-text note for template authors. Never rendered. */
  $comment?: string;
  specVersion: SpecVersion;
  template: TemplateIdentity;
  /**
   * The canonical model whose concept names this template's fields use.
   *
   * Declaring it means a reader can tell which vocabulary `value.concept`
   * refers to, and a tool can refuse to apply a binding profile written
   * against a different one.
   */
  model?: ModelIdentity;
  /**
   * Concept name to data reference. This is the only place a template that
   * uses concepts touches the shape of a data set, so re-pointing a whole
   * form at a differently shaped return is one block of edits, not a hundred.
   *
   * A profile supplied at resolution time overrides what is written here.
   */
  bindings?: Record<string, ValueSpec>;
  /** Style and format values inherited by every field unless overridden. */
  defaults?: { style?: Style; format?: Format };
  /**
   * Where field references resolve from by default. A reference beginning
   * with `@` is resolved relative to this pointer; one beginning with `$`
   * or `/` is resolved from the document root.
   */
  bind?: { root: Reference };
  entries: Entry[];
}

export interface TemplateIdentity {
  /** Reverse-DNS style, namespaced by jurisdiction and tax year. */
  id: string;
  title: string;
  /** Filing year the form applies to, not the year it was printed. */
  taxYear: number;
  /** Issuer's revision marker, e.g. the "Rev. 12-2024" on the form itself. */
  revision: string;
  /** OMB control number, when the form carries one. */
  ombNumber?: string;
  source: SourceDocument;
  geometry: Geometry;
}

/**
 * Identifies the exact PDF the coordinates were measured against. The digest
 * is what makes a template safe to reuse: if the issuer reposts the form,
 * the digest stops matching and the mismatch surfaces as a build failure
 * rather than as every box silently shifting by a few points.
 */
export interface SourceDocument {
  filename: string;
  /** Lowercase hex SHA-256 of the unmodified source PDF. */
  sha256: string;
  pageCount: number;
  /** Where the authoritative copy can be re-fetched. */
  url?: string;
}

export interface Geometry {
  /** Only PostScript points (1/72 inch) are defined in v1. */
  unit: "pt";
  /**
   * Only `top-left` is defined in v1: x grows right, y grows down.
   * PDF user space is bottom-left origin, so a renderer converts with
   *   pdfY = pageHeight - y - height
   * applied once, at draw time.
   */
  origin: "top-left";
  pages: PageGeometry[];
}

export interface PageGeometry {
  width: number;
  height: number;
  /** Clockwise page rotation in degrees, as recorded in the source PDF. */
  rotation?: 0 | 90 | 180 | 270;
}

// ---------------------------------------------------------------------------
// Entries: a flat field, or a repeating row group
// ---------------------------------------------------------------------------

export type Entry = Field | RepeatGroup;

export type FieldType =
  | "text"
  | "multilineText"
  | "currency"
  | "number"
  | "percentage"
  | "date"
  | "comb"
  | "checkbox"
  | "staticText";

export interface Field {
  $comment?: string;
  kind: "field";
  /** Unique within the template. Stable across revisions where the line survives. */
  id: string;
  /** Human label for tooling and error messages; never rendered. */
  label?: string;
  /** Zero-based index into `template.geometry.pages`. */
  page: number;
  type: FieldType;
  /** [x, y, width, height] of the printable box, in points, top-left origin. */
  rect: Rect;
  value: ValueSpec;
  format?: Format;
  style?: Style;
  /** Field is skipped entirely when this condition is false. */
  visibleWhen?: Condition;
  /**
   * Marks mutually exclusive checkboxes (filing status, accounting method).
   * A linter MUST report a group in which more than one member can be true.
   */
  radioGroup?: string;
  /** Required when `type` is "comb"; forbidden otherwise. */
  comb?: CombSpec;
  /**
   * Optional separate cents column, as ruled on many IRS forms. When present
   * the dollar portion prints in `rect` and the cents portion in `cents.rect`.
   */
  cents?: { rect: Rect; style?: Style };
}

export type Rect = [x: number, y: number, width: number, height: number];

/**
 * One character per cell, as used for SSN, EIN and date boxes.
 *
 * Cell width is derived, never authored:
 *   cellWidth = (rect.width - sum(gaps)) / cells
 *
 * `gaps` is keyed by the number of cells that precede the gap, so an SSN
 * laid out 3-2-4 is `{ cells: 9, gaps: { "3": 6, "5": 6 } }`.
 */
export interface CombSpec {
  cells: number;
  gaps?: Record<string, number>;
}

export interface RepeatGroup {
  $comment?: string;
  kind: "repeat";
  id: string;
  label?: string;
  page: number;
  /**
   * The collection being iterated. MUST resolve to an array.
   *
   * A reference begins with `$`, `@` or `/`; anything else is a concept name
   * resolved through `bindings`. The two cannot be confused, because a concept
   * name may not start with those characters.
   */
  over: Reference | string;
  /** Top-left corner of the first item's block. */
  origin: [x: number, y: number];
  /**
   * How far to advance between consecutive items, in points.
   *
   * A vector rather than a row height, because real forms repeat in both
   * directions: Schedule C lists expenses down the page as `[0, 18]`, while
   * Form 1040 lays its four dependents out across the page as `[108, 0]`.
   */
  step: [dx: number, dy: number];
  /** How many items the form physically provides room for. */
  capacity: number;
  /**
   * What to do when the collection is longer than `capacity`.
   *  - "continuation": fill `capacity - 1` slots, collapse the remainder into
   *    the final slot, and emit a ContinuationStatement for the host to print.
   *  - "truncate": fill the first `capacity` slots and drop the rest.
   *  - "error": refuse to render. The default, because silently dropping
   *    entries from a tax return is worse than failing loudly.
   */
  overflow?: "continuation" | "truncate" | "error";
  continuation?: { statementId: string; title: string };
  /**
   * The fields of a single item. Each `rect` is relative to the item block's
   * top-left corner, so the block is described once and reused for every
   * element. References inside an item resolve against the current element
   * via `@`.
   */
  item: { fields: Omit<Field, "page">[] };
}

// ---------------------------------------------------------------------------
// Value references
// ---------------------------------------------------------------------------

/**
 * Either an RFC 6901 JSON Pointer (`/income/w2/0/wages`, or `@/wages`
 * relative to the current binding) or the JSONPath-lite subset defined in
 * SPEC.md (`$.income.w2[*].wages`, `@.amount`).
 *
 * JSON Pointer is the canonical form: it is unambiguous and trivially
 * implementable anywhere. JSONPath-lite exists for authoring convenience
 * and is restricted to a grammar with no arithmetic, no function calls and
 * no recursive descent, so resolution stays total and side-effect free.
 */
export type Reference = string;

export interface ValueSpec {
  /**
   * A canonical concept name, resolved through the template's `bindings`
   * (or an overriding profile) to the ValueSpec that actually reads the data.
   *
   * Mutually exclusive with `ref` and `const`. A field that names a concept
   * says *what* it prints; the binding says *where that lives in this
   * particular data set*.
   */
  concept?: string;
  /** Mutually exclusive with `const` and `concept`. */
  ref?: Reference;
  /** A literal value, for pre-printed text and fixed marks. */
  const?: string | number | boolean;
  /**
   * Required when `ref` can resolve to more than one node; a multi-valued
   * reference without an aggregate is an error, never an implicit "first".
   */
  aggregate?: "sum" | "count" | "first" | "last" | "min" | "max" | "join";
  /** Separator for `aggregate: "join"`. Default ", ". */
  separator?: string;
  transform?: Transform[];
  /** Tried in order when `ref` resolves to nothing. */
  fallback?: Reference[];
  /** Used when `ref` and every `fallback` resolve to nothing. */
  default?: string | number | boolean | null;
  /**
   * Checkbox predicate: the mark is printed when the resolved value equals
   * this. Omit on a checkbox to mean "print when truthy".
   */
  equals?: string | number | boolean;
}

export type Transform =
  | "digitsOnly"
  | "upper"
  | "lower"
  | "trim"
  | "abs"
  | "negate";

export interface Condition {
  ref: Reference;
  equals?: string | number | boolean;
  notEquals?: string | number | boolean;
  exists?: boolean;
  truthy?: boolean;
  gt?: number;
  lt?: number;
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

export interface Format {
  decimals?: number;
  rounding?: "half-up" | "half-even" | "truncate";
  /** Thousands separators. IRS practice is usually false in ruled boxes. */
  thousands?: boolean;
  /** IRS convention is parentheses, not a leading minus. */
  negative?: "parentheses" | "minus" | "none";
  /** Print nothing rather than "0". */
  blankIfZero?: boolean;
  /** Print nothing rather than the `default` when the reference is empty. */
  blankIfNull?: boolean;
  prefix?: string;
  suffix?: string;
  /** Token format for `date` fields, e.g. "MM/DD/YYYY". */
  dateFormat?: string;
}

export interface Style {
  font?: "Helvetica" | "Helvetica-Bold" | "Courier" | "Courier-Bold" | "Times-Roman";
  size?: number;
  color?: string;
  align?: "left" | "center" | "right";
  vAlign?: "top" | "middle" | "bottom";
  padding?: { top?: number; right?: number; bottom?: number; left?: number };
  letterSpacing?: number;
  lineHeight?: number;
  /**
   * Behaviour when the rendered text is wider than the box.
   * Defaults to "error" so that a value which does not fit stops the run
   * instead of overprinting a neighbouring line.
   */
  overflow?: "error" | "shrink" | "truncate" | "ellipsis" | "wrap";
  /** Floor for `overflow: "shrink"`. Default 6. */
  minSize?: number;
  /** Mark drawn in a checked checkbox. Default "X". */
  glyph?: string;
}

export interface ModelIdentity {
  id: string;
  version: SpecVersion;
}

/**
 * Binds a canonical model's concepts to one data set's shape.
 *
 * Kept separate from the template because the two change for different
 * reasons: a template changes when the *form* changes, a profile when the
 * *data* changes. One form, several profiles is the normal case — a firm
 * migrating its return model writes a new profile and every template follows.
 */
export interface BindingProfile {
  $comment?: string;
  profileVersion: SpecVersion;
  /** Template id this profile is written for, or "*" for any. */
  for: string;
  model: ModelIdentity;
  bindings: Record<string, ValueSpec>;
}

// ---------------------------------------------------------------------------
// Render plan: the intermediate representation
// ---------------------------------------------------------------------------

/**
 * The compile target.
 *
 * A template is authored; a render plan is produced. Splitting the two is
 * what lets a host application use its own rendering stack: it consumes a
 * plan and never needs to understand templates, references or formatting.
 *
 * A plan MUST be self-contained. Every value needed to draw a placement is
 * present on the placement itself — a consumer that has only the plan can
 * draw a correct page. Nothing is resolved by looking back at the template,
 * because a consumer is not required to have one.
 *
 * The one thing a plan deliberately does not contain is font metrics. Those
 * differ between implementations, so fitting text is left to the stage that
 * owns the fonts (see `PlacedText.overflow`).
 */
export interface RenderPlan {
  /**
   * Version of the plan format, independent of `specVersion`. A template
   * format may gain features without changing what a renderer consumes, and
   * a renderer pins this rather than the specification version.
   */
  planVersion: SpecVersion;
  templateId: string;
  templateRevision: string;
  taxYear: number;
  /** Repeated from the template so a plan alone can be checked against a PDF. */
  source: SourceDocument;
  /** Repeated so a consumer can convert to its own coordinate space. */
  geometry: Geometry;
  placements: PlacedText[];
  statements: ContinuationStatement[];
  diagnostics: Diagnostic[];
}

/**
 * One string, fully resolved, with everything needed to draw it.
 *
 * Every presentation property is required and already merged from the
 * template defaults, so a consumer never applies an inheritance rule of its
 * own and two consumers cannot disagree about what a missing value meant.
 */
export interface PlacedText {
  fieldId: string;
  page: number;
  /** [x, y, width, height] in points, top-left origin. */
  rect: Rect;
  text: string;
  font: string;
  size: number;
  color: string;
  align: "left" | "center" | "right";
  vAlign: "top" | "middle" | "bottom";
  /** Resolved on all four sides; a checkbox always resolves to zero. */
  padding: { top: number; right: number; bottom: number; left: number };
  /** Applied by the drawing stage, which is the stage that has font metrics. */
  overflow: "error" | "shrink" | "truncate" | "ellipsis" | "wrap";
  minSize: number;
  lineHeight: number;
  /**
   * Per-character cells for a comb field, absent otherwise. Cell geometry is
   * derived from the template and carried here so that it cannot be
   * re-derived differently downstream.
   */
  cells?: { x: number; width: number; char: string }[];
}

export interface ContinuationStatement {
  statementId: string;
  title: string;
  sourceEntryId: string;
  columns: string[];
  rows: string[][];
}

export interface Diagnostic {
  severity: "error" | "warning";
  code: string;
  entryId?: string;
  message: string;
}

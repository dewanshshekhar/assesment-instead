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
  /** Reference to the array being iterated. MUST resolve to an array. */
  over: Reference;
  /** Top-left corner of the first row. */
  origin: [x: number, y: number];
  /** Baseline-to-baseline distance between rows, in points. */
  rowHeight: number;
  /** Number of printed rows the form physically provides. */
  maxRows: number;
  /**
   * What to do when the array is longer than `maxRows`.
   *  - "continuation": print `maxRows - 1` rows, collapse the remainder into
   *    the final row, and emit a ContinuationStatement for the host to print.
   *  - "truncate": print the first `maxRows` and drop the rest.
   *  - "error": refuse to render. The default, because silently dropping
   *    rows from a tax return is worse than failing loudly.
   */
  overflow?: "continuation" | "truncate" | "error";
  continuation?: { statementId: string; title: string };
  /**
   * Fields of a single row. Each `rect` is relative to the row's top-left
   * corner, so a row definition is written once and reused for every item.
   * References inside a row resolve against the current item via `@`.
   */
  row: { fields: Omit<Field, "page">[] };
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
  /** Mutually exclusive with `const`. */
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

// ---------------------------------------------------------------------------
// Renderer output contract
// ---------------------------------------------------------------------------

/**
 * What a conforming renderer produces before it touches a PDF. Splitting
 * resolution from drawing is what lets a host application use its own
 * rendering stack: it can consume `PlacedText` directly and ignore the
 * reference implementation entirely.
 */
export interface RenderPlan {
  templateId: string;
  placements: PlacedText[];
  statements: ContinuationStatement[];
  diagnostics: Diagnostic[];
}

export interface PlacedText {
  fieldId: string;
  page: number;
  /** Resolved top-left origin of the text box, in points. */
  rect: Rect;
  text: string;
  font: string;
  size: number;
  color: string;
  align: "left" | "center" | "right";
  /** Per-character cells for comb fields; absent for ordinary text. */
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

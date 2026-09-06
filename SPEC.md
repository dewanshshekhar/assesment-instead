# Tax Form Annotation Specification

**Version 1.0.0**

A declarative description of where and how to print computed values onto a
fixed-layout U.S. tax form.

An *annotation template* describes one form. Given a template and a taxpayer
data set, any implementation can determine which string belongs in which box,
in which font, at which position — without knowing anything about tax law and
without sharing any code with the system that produced the data.

---

## 1. Scope

### 1.1 In scope

- Locating every printable box on a form, to the point.
- Describing how a value is drawn: font, size, alignment, overflow behaviour.
- Selecting a value out of an arbitrarily nested data set.
- Repeating a row over a collection, and handling collections larger than the
  form provides room for.
- Tying a set of coordinates to the exact revision of the PDF they were
  measured against.

### 1.2 Out of scope (deliberate non-goals)

- **Tax calculation.** A template never computes a tax figure. If line 9 is
  the sum of lines 1a through 8, the *calculation engine* produces that total
  and the template references it. See §5.6.
- **Data validation.** Whether an SSN is well-formed is the data producer's
  concern.
- **Drawing.** A conforming implementation may render with any PDF library, or
  to a printer, or to a screen. The reference renderer in `tools/` is a proof
  of implementability, not part of this specification.
- **Electronic filing.** MeF XML is a different serialisation of the same
  return; see `DECISIONS.md` §4.

### 1.3 Conformance

The key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT** and **MAY**
are to be interpreted as described in RFC 2119.

An implementation is *conforming* if it accepts every template that validates
against `spec/annotation-template.schema.json`, rejects every template that
does not, and produces placements consistent with §4 through §11.

---

## 2. Document structure

A template is a single JSON document.

```jsonc
{
  "specVersion": "1.0.0",
  "template":  { /* identity, source integrity, page geometry — §3, §12 */ },
  "defaults":  { /* style and format inherited by every field — §9 */ },
  "bind":      { "root": "$.taxReturn" },        // §5.4
  "entries":   [ /* fields (§7) and repeat groups (§10) */ ]
}
```

`entries` is a flat, ordered list. Order affects nothing except the order of
the resulting placements; boxes do not nest.

Every object in the document MAY carry a `$comment` string, which is never
rendered.

---

## 3. Coordinates

### 3.1 Units and origin

```jsonc
"geometry": {
  "unit": "pt",
  "origin": "top-left",
  "pages": [ { "width": 612, "height": 792, "rotation": 0 } ]
}
```

- The unit is the **PostScript point**, 1/72 inch. `unit` MUST be `"pt"` in
  version 1.
- The origin is the **top-left corner of the page**; `x` grows right and `y`
  grows **down**. `origin` MUST be `"top-left"` in version 1.

PDF user space has its origin at the bottom-left with `y` growing up. A
renderer therefore converts exactly once, at draw time:

```
pdfX = x
pdfY = pageHeight - y - height
```

Top-left was chosen because every person who annotates a form reads it top to
bottom, and because it matches HTML, Canvas and every screen-measuring tool
they will use to find a coordinate. Doing the flip once, in one place, is
easier to get right than asking each author to invert every number by hand.

### 3.2 Rectangles

Every printable position is a rectangle, never a bare point:

```jsonc
"rect": [x, y, width, height]
```

A point cannot express "right-aligned in this box" or "centred in this
square", which is precisely what a ruled tax form demands: dollar amounts sit
flush right against the cents rule, and a checkmark sits centred in its box.
Width and height MUST be greater than zero.

A renderer MUST NOT draw outside a field's rectangle. See §9.3 for what
happens when the text does not fit.

### 3.3 Pages

`page` is a zero-based index into `geometry.pages`. A template MUST NOT
reference a page it does not declare, and every rectangle MUST fall within
its page's bounds.

---

## 4. The data set

The data set is an arbitrary JSON document. This specification imposes no
schema on it whatsoever — it is whatever the calculation engine produces.
Everything a template knows about that document, it knows through references.

---

## 5. References

> This is the mechanism by which a template reaches a specific value inside a
> deeply nested data set.

### 5.1 Two syntaxes, one meaning

Every reference begins with a **scope marker**:

| Marker | Resolves from |
|--------|---------------|
| `$`    | the root of the data set |
| `@`    | the node the current binding points at (§5.4) |
| `/`    | shorthand for `$/` |

What follows the marker selects the syntax:

| Next character | Syntax | Example |
|----------------|--------|---------|
| `/` or nothing | JSON Pointer (RFC 6901) | `$/income/w2/0/wages`, `@/amount`, `@` |
| `.` or `[`     | JSONPath-lite (§5.3)    | `$.income.w2[*].wages`, `@.amount` |

Both are resolved by the same engine and mean exactly the same thing where
they overlap. **JSON Pointer is the canonical form**: it is a published
standard, it is unambiguous, and it can be implemented in a dozen lines in
any language. JSONPath-lite exists because writing
`$.schedules.scheduleC[?(@.id == 'biz-1')].expenses[*].amount` by hand is far
less error-prone than its pointer-plus-filter equivalent.

Pointer tokens follow RFC 6901 escaping: `~1` is a literal `/` and `~0` is a
literal `~`. A numeric token indexes an array.

### 5.2 A reference selects a *list*

Resolution always yields an ordered list of nodes, possibly empty.

- **Empty is not an error.** "This taxpayer has no Schedule C" is ordinary
  input, not a failure. An empty result means the field prints nothing,
  unless a `fallback` or `default` applies (§6.2).
- **More than one node requires an explicit `aggregate`** (§6.1). An
  implementation MUST NOT silently take the first of several nodes. Quietly
  printing the first of two W-2s onto line 1a is exactly the class of bug
  that reaches a filed return without anybody noticing.

### 5.3 The JSONPath-lite grammar

Supported, and nothing else:

| Form | Meaning |
|------|---------|
| `.name` | child by name |
| `['name']` | child by name, for names that are not identifiers |
| `[n]` | array element by index |
| `[-n]` | array element counted from the end |
| `[*]` | every element of an array, or every value of an object |
| `[?(@.field == 'x')]` | elements whose `field` equals a literal |
| `[?(@.a.b != 3)]` | the same, negated; the left side may be a dotted path |

Literals are single-quoted strings, numbers, `true`, `false` and `null`.

Explicitly **not** supported: recursive descent (`..`), slices (`[0:2]`),
comparison operators other than `==` and `!=`, arithmetic, function calls,
script expressions, and unions.

The restriction is the point. Resolution over this grammar is total: it
cannot loop, cannot throw on unexpected data, cannot reach outside the
document, and is small enough that a third party can reimplement it
faithfully. An expression language would make templates a place where
business logic accumulates, which is exactly what §1.2 rules out.

Property lookup MUST use the object's own enumerable keys only. `$.constructor`
and `/__proto__` MUST select nothing.

### 5.4 Bindings, and forms filed more than once

Several forms are filed once per subject: a Schedule C per business, a
Schedule E per property. Duplicating the whole template per copy would be
unmaintainable.

Instead, a template declares a **binding**, and every `@` reference resolves
relative to it:

```jsonc
"bind": { "root": "$.taxReturn.schedules.scheduleC[?(@.id == 'biz-1')]" }
```

The rest of the template is written once against `@.income.grossReceipts`,
`@.expenses`, and so on. Printing the second business is the same template
with one line changed. If `bind.root` selects more than one node the first is
used; if it selects nothing, `@` falls back to the document root and the
implementation SHOULD warn.

Inside a repeat group (§10) the binding is the **current item**, which is how
one row definition serves every row.

### 5.5 Worked example

Against `examples/sample-return.json`:

| Reference | Selects |
|-----------|---------|
| `$.taxReturn.taxpayer.identifiers.ssn` | `"412-88-9017"` |
| `/taxReturn/income/w2/0/wages` | `84500` |
| `$.taxReturn.income.w2[*].wages` | `[84500, 12750.5]` — needs an aggregate |
| `$.taxReturn.schedules.scheduleC[?(@.id == 'biz-2')].netProfit` | `7770` |
| `$.taxReturn.schedules.scheduleC[*].expenses[*].amount` | every expense of every business |
| `@.income.grossReceipts` (bound to biz-1) | `128400` |

### 5.6 Why totals are referenced, not computed

Form 1040 line 9 is the sum of lines 1a through 8. A template could express
that as arithmetic over other fields. It MUST NOT.

The same total is needed for e-filing, for the taxpayer's summary screen and
for next year's carryforward. If the annotation layer computed it, there
would be two implementations of one rule and they would eventually disagree —
and the printed return would be the one that is wrong. The calculation engine
owns the arithmetic; the template references `@.totals.totalIncome`.

`aggregate: "sum"` (§6.1) is not an exception to this. It restates a total
the data already contains element by element; it does not introduce a rule
that exists nowhere else.

---

## 6. Values

```jsonc
"value": {
  "ref": "$.income.w2[*].wages",
  "aggregate": "sum",
  "transform": ["digitsOnly"],
  "fallback": ["$.income.estimatedWages"],
  "default": 0,
  "equals": "MARRIED_FILING_JOINTLY"
}
```

A `value` MUST declare exactly one of `ref` or `const`. `const` is a literal,
used for pre-printed marks and fixed text.

### 6.1 Aggregates

| Aggregate | Result |
|-----------|--------|
| `sum`, `min`, `max` | arithmetic over the selected nodes; every node MUST be numeric |
| `count` | how many nodes were selected |
| `first`, `last` | one node, chosen explicitly |
| `join` | the nodes as text, joined with `separator` (default `", "`) |

An implementation MUST raise an error when a numeric aggregate meets a
non-numeric node, rather than coercing it.

### 6.2 Resolution order

1. Resolve `ref`. If it selects nothing, try each `fallback` in order.
2. If nothing resolved, use `default`.
3. If there is no `default`, the field is **missing** and prints nothing.
4. Apply `transform` in the order written.

Transforms: `digitsOnly`, `upper`, `lower`, `trim`, `abs`, `negate`.
`digitsOnly` is what turns `"412-88-9017"` into the nine characters a comb
field needs.

### 6.3 Checkboxes

A checkbox prints its `glyph` when its predicate holds:

- with `equals`, when the resolved value equals it;
- without `equals`, when the resolved value is truthy.

A missing value is never checked.

---

## 7. Field types

| Type | Purpose |
|------|---------|
| `text` | single-line text |
| `multilineText` | text wrapped over several lines |
| `currency` | a money amount, optionally split across a cents column |
| `number` | a plain number |
| `percentage` | a rate, printed in the units it arrives in (§8.2) |
| `date` | a date, reformatted from ISO 8601 |
| `comb` | one character per ruled cell — §7.1 |
| `checkbox` | a mark in a ruled square — §7.3 |
| `staticText` | fixed text from `const` |

### 7.1 Comb fields

Identifiers on U.S. tax forms are printed one character per ruled cell: an
SSN in a 3‑2‑4 grouping, an EIN in 2‑7. A specification that can only place a
string in a box cannot express this at all, which is why `comb` is a
first-class type rather than a styling option.

```jsonc
{
  "type": "comb",
  "rect": [432, 88, 144, 16],
  "comb": { "cells": 9, "gaps": { "3": 8, "5": 8 } },
  "value": { "ref": "@.taxpayer.identifiers.ssn", "transform": ["digitsOnly"] }
}
```

- `cells` is the number of character positions.
- `gaps` adds space **in points**, keyed by the number of cells that precede
  the gap. `{"3": 8, "5": 8}` is the 3‑2‑4 SSN grouping; `{"2": 10}` is an EIN.
- Cell width is **derived, never authored**:
  `cellWidth = (rect.width − Σ gaps) / cells`.
  An author who moves the box does not have to recompute anything.
- Each character is centred in its own cell.
- A value shorter than `cells` fills from the left; the remaining cells stay
  blank. A value longer than `cells` MUST be reported as an error, never
  truncated silently.
- `padding` does not apply to a comb field.

### 7.2 Currency and the cents column

Many forms rule dollars and cents as separate columns. A `currency` field MAY
declare a second rectangle:

```jsonc
"type": "currency",
"rect":  [462, 232, 92, 14],
"cents": { "rect": [556, 232, 30, 14], "style": { "align": "center" } },
"format": { "decimals": 2 }
```

The formatted amount is split on its decimal point. The dollar part —
including any grouping separators and the sign — prints in `rect`; the two
cent digits print in `cents.rect` with no sign or separator of their own. A
cents column requires `decimals: 2`.

### 7.3 Checkboxes

`padding` does not apply to a `checkbox`: the glyph is centred within the
full rectangle. A 10pt ruled square with an inherited 3pt text inset leaves
no room for a mark at all, so text padding MUST NOT be inherited here.

Mutually exclusive checkboxes SHOULD declare a shared `radioGroup`. A
validator MUST report a group in which more than one member can be marked.

---

## 8. Formatting

```jsonc
"format": {
  "decimals": 2,
  "rounding": "half-up",
  "thousands": false,
  "negative": "parentheses",
  "blankIfZero": true,
  "prefix": "", "suffix": "",
  "dateFormat": "MM/DD/YYYY"
}
```

### 8.1 Money

- `negative` defaults to **`parentheses`** for `currency`. IRS forms write a
  loss as `(1,234)`, not `-1234`.
- `blankIfZero` defaults to **true** for `currency`. A ruled line left blank
  and a line reading `0` do not mean the same thing on a tax form.
- `decimals` defaults to **0**: whole-dollar reporting is the norm.
- `rounding` defaults to `half-up`, meaning **half away from zero**, matching
  the whole-dollar rule of rounding 50 cents up.
- Rounding MUST be performed on scaled integers, not by formatting a binary
  float. `2.675` at two decimals MUST produce `2.68`.

### 8.2 Percentages

A `percentage` value is taken to be **already in percent units**: `12.5`
prints as `12.5`. Scaling a ratio into a percentage is arithmetic, and
arithmetic belongs in the calculation engine (§5.6).

### 8.3 Dates

`date` accepts an ISO 8601 date, optionally with a time part, and rewrites it
using `YYYY`, `YY`, `MM` and `DD`. Parsing MUST be performed on the string.
Constructing a local `Date` can shift the day across a time zone boundary,
and a date on a tax return that is off by one day is a defect.

### 8.4 Empty values

A missing value, `null`, and the empty string all print nothing. They MUST
NOT print as `0`, `null` or `undefined`.

---

## 9. Style

```jsonc
"style": {
  "font": "Helvetica", "size": 9, "color": "#000000",
  "align": "right", "vAlign": "middle",
  "padding": { "left": 3, "right": 4 },
  "overflow": "error", "minSize": 6, "glyph": "X"
}
```

### 9.1 Inheritance

`defaults.style` and `defaults.format` are shallow-merged under each field's
own values. There is one level of inheritance and no cascade, because a
cascade makes "why is this box in 7pt?" a question that cannot be answered by
reading one object.

### 9.2 Fonts

Version 1 defines the PDF base-14 subset: `Helvetica`, `Helvetica-Bold`,
`Courier`, `Courier-Bold`, `Times-Roman`. Every implementation has them and
no font file needs to travel with a template. `Courier` is the sensible
choice for comb fields.

### 9.3 Overflow

`overflow` decides what happens when text is wider than its box:

| Value | Behaviour |
|-------|-----------|
| `error` | **default** — refuse to draw and report a diagnostic |
| `shrink` | reduce the size down to `minSize` until it fits |
| `truncate` | drop trailing characters |
| `ellipsis` | drop trailing characters and append `…` |
| `wrap` | break across lines using `lineHeight` |

`error` is the default deliberately. A number that overflows its box on a tax
return is either the wrong number or the wrong box; both are worth stopping
for. Truncation is available, but it must be asked for.

Because text measurement depends on the implementation's own font metrics,
overflow is resolved at **draw** time, not in the render plan (§11).

---

## 10. Repeat groups

A repeat group prints one block of fields per element of a collection.

```jsonc
{
  "kind": "repeat",
  "id": "p1.dependents",
  "page": 0,
  "over": "@.dependents",
  "origin": [145, 309],
  "step": [108, 0],
  "capacity": 4,
  "overflow": "continuation",
  "continuation": {
    "statementId": "stmt.f1040.dependents",
    "title": "Additional dependents"
  },
  "item": { "fields": [ /* rects relative to the item block's top-left corner */ ] }
}
```

- `over` MUST resolve to an array.
- Item *n* is drawn at `origin + n × step`. Each field's `rect` inside `item`
  is **relative to the item block's top-left corner**, so the block is
  described once.
- Inside an item, `@` binds to the **current element**; `$` still reaches the
  document root.
- Each placement is identified as `<groupId>[<n>].<fieldId>`, so a host
  application can map every drawn string back to the element it came from.

### 10.1 `step` is a vector, not a row height

Forms repeat in both directions, and a specification that assumes rows cannot
describe half of them.

| Form | Layout | `step` |
|------|--------|--------|
| Schedule C, Part II expenses | one expense per line, down the page | `[0, 18]` |
| Form 1040, dependents | one dependent per column, across the page | `[108, 0]` |

The dependents block on Form 1040 is genuinely column-major: first name, last
name, SSN and relationship run *down* within one dependent, and successive
dependents advance *right*. Expressing that needs an advance vector; a scalar
row height cannot.

`capacity` is likewise named for slots rather than rows, because a slot may be
a column.

### 10.2 More elements than the form has room for

A return with five dependents and a form with four columns is normal, not
exceptional. `overflow` says what to do:

| Value | Behaviour |
|-------|-----------|
| `error` | **default** — refuse to render and report a diagnostic |
| `truncate` | fill the first `capacity` slots and drop the rest |
| `continuation` | fill `capacity − 1` slots; collapse the remainder into the last one and emit a statement |

Under `continuation`:

- Numeric fields in the final slot carry the **total of the spilled
  elements**, so the form's own arithmetic still reconciles.
- The **first** text field in the final slot reads `See attached: <title>`.
  Only the first: an item may hold several text fields — a dependent has a
  first name, a last name and a relationship — and repeating the pointer in
  each of them is noise on a form a person has to read.
- Fields of any other type in the final slot are left blank. A partial
  identifier in a comb box would be worse than an empty one.
- A `ContinuationStatement` (§11) is emitted carrying every spilled element in
  full. Printing it is the host application's business — an appended page, a
  separate document, or an e-file attachment.

Dropping elements silently is never the default, because a dropped dependent
is a misstated return.

## 11. The render plan

Resolution and drawing are separate stages, and the boundary between them is
a document in its own right.

```
template + data  ──resolve──▶  render plan  ──draw──▶  pages
   (authored)                 (intermediate)          (any stack)
```

A template is authored by a person. A **render plan** is produced from it.
The plan is the interchange format, and it is what a host application
consumes: it can take a plan and draw with its own PDF library, its own
licensed fonts and its own colour management, without implementing any of
§5 through §10.

### 11.1 Shape

```jsonc
{
  "planVersion": "1.0.0",
  "templateId": "us.irs.f1040sc.2024",
  "templateRevision": "2024-12",
  "taxYear": 2024,
  "source":   { "filename": "f1040sc.pdf", "sha256": "2d69ea9e…", "pageCount": 1 },
  "geometry": { "unit": "pt", "origin": "top-left", "pages": [ { "width": 612, "height": 792 } ] },
  "placements": [
    {
      "fieldId": "sc.line1",
      "page": 0,
      "rect": [462, 240, 92, 14],
      "text": "128400",
      "font": "Helvetica", "size": 9, "color": "#000000",
      "align": "right", "vAlign": "middle",
      "padding": { "top": 0, "right": 4, "bottom": 0, "left": 3 },
      "overflow": "error", "minSize": 6, "lineHeight": 1.15
    }
  ],
  "statements": [ /* §10.1 */ ],
  "diagnostics": [ /* §13 */ ]
}
```

`spec/render-plan.schema.json` is the normative schema.

### 11.2 A plan MUST be self-contained

Every value needed to draw a placement is present **on the placement**.
Presentation properties are not optional in a plan: `defaults` (§9.1) are
already merged, and every property is resolved to a concrete value.

This is a hard requirement, not a convenience. A consumer is not required to
possess the template — that is the entire point of the stage boundary. If a
consumer had to fall back on a default of its own for an absent property,
two consumers would disagree about what the absence meant, and the same plan
would print two different forms.

Two consequences worth stating explicitly:

- `padding` is resolved on all four sides. For a `checkbox` it is always
  zero, because the rule in §7.3 is a property of the specification and must
  not be re-derived by each renderer.
- Comb `cells` are carried with their computed `x` and `width` (§7.1), so
  cell geometry cannot be recomputed differently downstream.

### 11.3 What a plan deliberately omits

**Font metrics.** Measuring a string depends on the implementation's own
fonts, so a plan never records a measured width. Instead each placement
carries the *policy* — `overflow`, `minSize`, `lineHeight` — and the drawing
stage, which owns the fonts, applies it (§9.3).

That omission is what makes plans comparable. Two independent
implementations resolving the same template against the same data MUST
produce the same plan, exactly, which is what lets a conformance suite
compare them (§11.5).

### 11.4 Versioning

`planVersion` is versioned **independently of `specVersion`**.

The template format and the interchange format change for different reasons
and are consumed by different people. A new field type or authoring
convenience may change the specification without changing anything a
renderer sees. A renderer therefore pins `planVersion`, not `specVersion`,
and an implementation MUST reject a plan whose major version it does not
recognise.

### 11.5 Conformance

Because a plan contains no font metrics and no implementation-defined
defaults, agreement between implementations can be checked exactly.

`conformance/plans/` holds a golden plan for each example template. An
implementation demonstrates conformance by producing the byte-identical
plan for the same template and data set. The reference implementation
asserts this on every test run, so a change to resolution, formatting or
geometry appears as a reviewable diff rather than as a silently different
tax form.

### 11.6 Reproducibility

Drawing the same plan onto the same source PDF SHOULD produce identical
output bytes. PDF writers stamp a modification time on save, which makes
otherwise identical output differ; an implementation SHOULD pin that
metadata rather than letting it float, so that two runs can be compared,
cached and regression-tested. The filing timestamp belongs to the return
data, not to document metadata.

## 12. Versioning and source integrity

```jsonc
"template": {
  "id": "us.irs.f1040.2024",
  "taxYear": 2024,
  "revision": "2024-12",
  "ombNumber": "1545-0074",
  "source": { "filename": "f1040.pdf", "sha256": "516ee91c…", "pageCount": 1 }
}
```

- `specVersion` is the version of *this specification* the document conforms
  to, and follows semantic versioning.
- `id` is namespaced by jurisdiction, agency, form and tax year. A template is
  **immutable once published**; a corrected template is a new revision.
- `source.sha256` is the digest of the exact PDF the coordinates were
  measured against.

The digest is the load-bearing part. Forms are reissued mid-season, and a
reissued PDF can shift every box by a few points while looking identical. An
implementation SHOULD refuse to render onto a PDF whose digest does not match
and MUST report the mismatch. The failure then surfaces as a build error
rather than as thousands of returns printed a little bit wrong.

Re-recording a digest MUST be a deliberate act (`tools/src/cli.ts stamp`),
because accepting a new digest is an assertion that the coordinates were
re-checked.

---

## 13. Diagnostics

Implementations report problems as diagnostics rather than exceptions
wherever a run can continue, so that one broken field does not hide the other
nineteen.

```jsonc
{ "severity": "error", "code": "value/ambiguous", "entryId": "p1.line1a",
  "message": "reference \"$.income.w2[*].wages\" selected 2 nodes but declares no 'aggregate'" }
```

Codes defined by this version:

| Code | Meaning |
|------|---------|
| `schema/invalid` | the template does not satisfy the template schema |
| `plan/invalid` | a render plan does not satisfy the plan schema |
| `reference/syntax` | a reference is outside the grammar of §5.3 |
| `reference/unresolved` | a reference selects nothing in the sample data |
| `value/ambiguous` | multi-valued reference with no aggregate |
| `value/not-numeric` | numeric aggregate over a non-numeric node |
| `comb/no-room`, `comb/narrow`, `comb/gap-past-end` | comb geometry is unusable |
| `comb/too-long` | the value has more characters than the comb has cells |
| `rect/out-of-bounds`, `rect/overlap` | box geometry is wrong or ambiguous |
| `page/out-of-range` | the page does not exist |
| `id/duplicate` | two entries share an id |
| `radio/singleton` | a radio group has one member |
| `repeat/overflow` | more items than rows, with `overflow: "error"` |
| `layout/overflow` | text does not fit, with `overflow: "error"` |
| `source/digest-mismatch` | the PDF is not the one the template was measured against |
| `bind/unresolved` | `bind.root` selects nothing |

A field that produces an error is **not drawn**. An implementation MUST NOT
print a partial or coerced value in its place.

---

## 14. Reserved

Unknown properties are rejected, not ignored: every object in the schema sets
`additionalProperties: false`. A misspelled `alignment` is a mistake worth
catching at authoring time, and strictness now is what makes it safe to add
properties in 1.1 later.

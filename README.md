# Tax Form Annotation Specification (TFAS)  

A data structure for annotating the fields and boxes of a U.S. tax form, so
that any application can print computed values into the right boxes using its
own code.

**The deliverable is the specification.** Everything under `tools/` is
supporting material: a reference implementation that proves the specification
is implementable, and the authoring tools you would want alongside it.

| Read this first | |
|---|---|
| **[`SPEC.md`](SPEC.md)** | The normative specification — coordinates, references, formatting, repeats |
| **[`DECISIONS.md`](DECISIONS.md)** | Why it is shaped this way, what it deliberately does not do, what comes next |
| [`spec/annotation-template.schema.json`](spec/annotation-template.schema.json) | JSON Schema for a template (draft 2020-12) |
| [`spec/render-plan.schema.json`](spec/render-plan.schema.json) | JSON Schema for the render plan — the interchange format |
| [`spec/binding-profile.schema.json`](spec/binding-profile.schema.json) | JSON Schema for a binding profile |
| [`spec/types.ts`](spec/types.ts) | The same model as typed interfaces |
| [`templates/us.irs.f1040.2025.json`](templates/us.irs.f1040.2025.json) | The official 2025 Form 1040, annotated |
| [`templates/us.irs.f1040sc.2025.json`](templates/us.irs.f1040sc.2025.json) | The official 2025 Schedule C, annotated |

---

## The problem

A tax form is a fixed piece of paper with ruled boxes. A return is a deeply
nested data structure. Something has to say *"the sum of every W-2's wages is
printed right-aligned in the box at (462, 232), whole dollars, with the cents
in the narrow column beside it"* — and it has to say it in a way that a team
who did not write it can implement independently.

That statement is what this specification defines.

## Two stages

A template is authored by a person. A **render plan** is compiled from it,
and that is what a printing application consumes.

```
template + data  ──resolve──▶  render plan  ──draw──▶  pages
   (authored)                 (interchange)          (any stack)
```

The plan is self-contained: every placement carries its own resolved font,
alignment, padding and overflow policy, so a consumer never needs the
template — which is what makes "print it with your own code" true rather
than merely claimed. The one thing a plan omits is font metrics, because
those belong to whichever stack does the drawing.

That omission is also what makes plans comparable. `conformance/plans/`
holds a golden plan per template; two implementations conform when they
produce byte-identical plans for the same input.

## What it covers

- **Positioning** — points, top-left origin, `[x, y, width, height]` boxes
  with alignment and padding, per page.
- **Formatting** — whole-dollar rounding, losses in parentheses, blank rather
  than zero, dates, fonts, and what to do when a value does not fit.
- **Referencing a value in a deeply nested data set** — RFC 6901 JSON Pointer
  as the canonical form, with a small, strictly-defined JSONPath subset for
  filters and wildcards.
- **Surviving a change to the data model** — a field may name a canonical
  *concept* instead of a path, and a binding profile says where that concept
  lives in a given return. Re-pointing a whole form at a new model is one block
  of edits, not a hundred.
- **The shapes real forms actually have** — one-character-per-cell comb boxes
  for SSN and EIN, separate cents columns, mutually exclusive checkboxes,
  repeating expense rows, and what happens when a taxpayer has more expenses
  than the form has lines.
- **Surviving next year** — every template is pinned to the digest of the
  exact PDF its coordinates were measured against.
- **Real forms, not idealised ones** — the 2025 Form 1040 and Schedule C
  templates are measured against the official PDFs. Between them they cover a
  dependents block that repeats *across* the page, twenty-four individually
  named expense lines each selected by a filter, and a free-form list in
  Part V that overflows onto a continuation statement.
- **Being checkable** — a versioned interchange format with its own schema,
  golden-plan conformance tests, and byte-reproducible output.

## What a template looks like

```jsonc
{
  "kind": "field",
  "id": "p1.line1a",
  "page": 0,
  "type": "currency",
  "rect": [462, 232, 92, 14],
  "cents": { "rect": [556, 232, 30, 14], "style": { "align": "center" } },
  "value": { "ref": "@.income.w2[*].wages", "aggregate": "sum" },
  "format": { "decimals": 2, "negative": "parentheses", "blankIfZero": true },
  "style": { "align": "right" }
}
```

An SSN, one digit per ruled cell, in the 3‑2‑4 grouping the form prints:

```jsonc
{
  "kind": "field", "id": "p1.ssn", "page": 0, "type": "comb",
  "rect": [432, 88, 144, 16],
  "comb": { "cells": 9, "gaps": { "3": 8, "5": 8 } },
  "value": { "ref": "@.taxpayer.identifiers.ssn", "transform": ["digitsOnly"] },
  "style": { "font": "Courier", "align": "center" }
}
```

Reaching into a deeply nested return, and binding a whole template to one
business so the same file prints every Schedule C:

```jsonc
"bind": { "root": "$.taxReturn.schedules.scheduleC[?(@.id == 'biz-1')]" }
```

## Try it

Requires Node 22.6 or newer. No build step.

```bash
cd tools
npm install
npm run demo     # fixtures, lint, render, compile a plan, check it, draw from it
npm test         # 99 tests
```

`npm run demo` walks the whole pipeline. It fills the **official 2025 Form 1040
and Schedule C** in `forms/` from the sample return, then compiles Schedule C to
`out/schedule-c.plan.json`, validates that file against the plan schema, and
renders it again **from the plan alone** — the renderer is handed no template
and no data set. The last step builds `out/browser-demo.html`.

That Schedule C has eleven other-expenses and nine ruled rows in Part V, so it
also produces a continuation statement: the last printed row carries the total
of what spilled, and the spilled rows are listed in full on an appended page.

## One form, two data shapes

`templates/us.irs.f1040sc.2025.json` binds nothing to a path directly. Its
fields name concepts — `business.income.grossReceipts`,
`business.expense.advertising` — and a `bindings` block says where those live.

`examples/alt-shape-return.json` is the same return under different key names
and different nesting: expenses keyed by name rather than a list filtered by
IRS line number, a different subject selector, different totals object.
`examples/bindings/alt-shape.json` binds the concepts to it.

```bash
npm run render:alt      # same template, other shape, no field edited
```

The two produce **byte-identical** output. A template describes a form; a
profile describes a data set; they change for different reasons.

## Someone else's renderer

`npm run demo:browser` writes `out/browser-demo.html`: a self-contained page
that fills Schedule C from the render plan using its own ~120 lines of
JavaScript. It shares no code with anything else here — it reads the plan,
applies each placement's rectangle, alignment, padding, comb cells and overflow
policy itself, and draws with the browser's text layout.

That is the specification's central claim made checkable rather than asserted:
a plan is enough for a third party to build the printing application with their
own code. Open it with a double-click; there is no server, no network and no
dependency.

## Repository map

```
SPEC.md                      the specification
DECISIONS.md                 trade-offs, limitations, future work
spec/
  annotation-template.schema.json   JSON Schema for a template
  render-plan.schema.json           JSON Schema for the interchange format
  types.ts                          the same model as typed interfaces
forms/
  f1040-2025.pdf                    the official blank forms, digest-pinned
  f1040sc-2025.pdf
templates/
  us.irs.f1040.2025.json            the official 2025 Form 1040, annotated
  us.irs.f1040sc.2025.json          the official 2025 Schedule C, annotated
  us.irs.f1040.2024.json            a fixture form, for the ruled cents column
examples/
  sample-return.json                a deeply nested return, internally consistent
examples/
  sample-return.json                a deeply nested return, internally consistent
  alt-shape-return.json             the same return, deliberately reshaped
  bindings/alt-shape.json           concepts bound to that other shape
  browser/                          a second, independent renderer
conformance/
  plans/                            golden render plans, asserted byte-for-byte
tools/                       supporting implementation — see tools/README.md
```

## The example forms

`us.irs.f1040.2025` and `us.irs.f1040sc.2025` are annotated against the
**official** blank forms committed in `forms/`. Their coordinates were not typed
by hand: `tools/src/cli.ts import` read them out of the PDFs' own form fields,
and `inspect` printed each field id onto the form so the bindings could be
checked against the paper.

`us.irs.f1040.2024` targets a form generated by `tools/src/fixtures.ts`. It is
kept for one reason: neither official form rules dollars and cents into separate
columns, and that feature needs somewhere to be demonstrated.

All three carry a real `source.sha256`, so the integrity check in `SPEC.md` §12
genuinely passes. See `DECISIONS.md` §3 for what the official forms revealed,
and what they could not.

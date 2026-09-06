# Tax Form Annotation Specification (TFAS) v1.0.0

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
| [`spec/types.ts`](spec/types.ts) | The same model as typed interfaces |
| [`templates/us.irs.f1040.2025.json`](templates/us.irs.f1040.2025.json) | The official 2025 Form 1040, annotated |

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
- **The shapes real forms actually have** — one-character-per-cell comb boxes
  for SSN and EIN, separate cents columns, mutually exclusive checkboxes,
  repeating expense rows, and what happens when a taxpayer has more expenses
  than the form has lines.
- **Surviving next year** — every template is pinned to the digest of the
  exact PDF its coordinates were measured against.
- **Real forms, not idealised ones** — the shipped 2025 Form 1040 template is
  measured against the official PDF, including its dependents block, which
  repeats *across* the page rather than down it.
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
npm test         # 90 tests
```

`npm run demo` walks the whole pipeline. It fills the **official 2025 Form
1040** in `forms/` from the sample return, then compiles Schedule C to
`out/schedule-c.plan.json`, validates that file against the plan schema, and
renders `out/schedule-c-filled.pdf` **from the plan alone** — the renderer is
handed no template and no data set.

That Schedule C has twelve expenses and nine ruled lines, so it also produces
a continuation statement: the last printed row carries the total of what
spilled, and the spilled rows are listed in full on an appended page.

## Repository map

```
SPEC.md                      the specification
DECISIONS.md                 trade-offs, limitations, future work
spec/
  annotation-template.schema.json   JSON Schema for a template
  render-plan.schema.json           JSON Schema for the interchange format
  types.ts                          the same model as typed interfaces
forms/
  f1040-2025.pdf                    the official blank form, digest-pinned
templates/
  us.irs.f1040.2025.json            the official 2025 Form 1040, annotated
  us.irs.f1040.2024.json            a fixture Form 1040, page 1
  us.irs.f1040sc.2024.json          a fixture Schedule C
examples/
  sample-return.json                a deeply nested return, internally consistent
conformance/
  plans/                            golden render plans, asserted byte-for-byte
tools/                       supporting implementation — see tools/README.md
```

## The example forms

`us.irs.f1040.2025` is annotated against the **official** blank form committed
in `forms/`. Its coordinates were not typed by hand: `tools/src/cli.ts import`
read them out of the PDF's own form fields, and `inspect` printed each field id
onto the form so the bindings could be checked against the paper.

The two `2024` templates target blank forms generated by
`tools/src/fixtures.ts`. They are kept because they exercise parts the official
form does not — a ruled cents column, and a repeat that runs down the page — and
because the demo still runs offline for anyone without the official PDF.

Both kinds carry a real `source.sha256`, so the integrity check in `SPEC.md`
§12 genuinely passes. See `DECISIONS.md` §3 for what the official form
revealed, and what it could not.

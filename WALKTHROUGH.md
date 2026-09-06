# Video walkthrough — running order

Five minutes, hard cap. The grading is on scope, cleanliness and the quality
of the walkthrough, so this is structured to demonstrate scope rather than
narrate the code.

Have open before recording: `SPEC.md`, `templates/us.irs.f1040.2025.json`,
`examples/sample-return.json`, `out/f1040-2025-filled.pdf`,
`out/schedule-c-2025-filled.pdf`, and a terminal in `tools/`.

---

## 0:00 – 0:35 — The problem

> A tax form is fixed paper with ruled boxes. A return is a deeply nested data
> structure. Something has to connect the two, and it has to be readable by a
> team that did not write it, because the brief says someone else builds the
> printing application with their own code.
>
> So the deliverable is a specification, not a renderer. The renderer in here
> exists to prove the specification is implementable.

Show the repository root. Point at `SPEC.md` and `DECISIONS.md`.

## 0:35 – 1:20 — The data model

Open the Schedule C template, scroll to `sc.line1`.

> Every field is a rectangle, not a point — `[x, y, width, height]`, points,
> top-left origin. A point cannot express "right-aligned against the cents
> rule" or "centred in this checkbox", and those are exactly what a ruled form
> demands. The flip into PDF's bottom-left space happens once, at draw time.

Point at `cents` on the same field.

> Real forms rule dollars and cents as separate columns, so `currency` can
> carry a second rectangle. The amount is split on the decimal point.

## 1:20 – 2:20 — Reaching into the nested data

Open `examples/sample-return.json` beside the template.

> This is the part the brief calls out specifically. Canonical form is RFC 6901
> JSON Pointer, because it is a standard and anyone can implement it. On top of
> that, a deliberately small JSONPath subset for the two things a pointer
> cannot do: wildcards and filters.

Show `p1.line1a` on the 1040: `$.income.w2[*].wages` with `aggregate: "sum"`.

> A reference always resolves to a *list*. Selecting nothing is fine — no
> Schedule C is ordinary input. Selecting more than one **requires** an explicit
> aggregate. Quietly taking the first of two W-2s is exactly how a wrong number
> reaches a filed return.

Show `bind.root` on the Schedule C.

> One Schedule C per business. The template binds to one business and every
> `@` reference hangs off that. Printing the second business changes one line —
> there is a test that does precisely that.

## 2:20 – 3:20 — On a real form

Show `out/f1040-2025-filled.pdf` full screen — the official 2025 Form 1040.

> This is the actual IRS form, filled from that data set. I did not type a
> single coordinate: the importer read them out of the PDF's own form fields.

Point at the SSN row, then the dependents block.

> SSNs are combs — one character per ruled cell, in the 3‑2‑4 grouping the form
> prints. Cell width is derived from the box, so moving the box recomputes
> nothing.
>
> The dependents block is the one that changed my design. Those four dependents
> are **columns**, not rows — first name, last name, SSN and relationship run
> down within one dependent, and successive dependents advance right. My first
> repeat model had a `rowHeight`, which simply cannot describe that. It is a
> step **vector** now: Schedule C's expenses are `[0, 18]`, these are `[108, 0]`.
>
> This return has five dependents and the form has four columns. Three print,
> the fourth carries the pointer, and the spilled two come out in full on a
> continuation statement. On Schedule C the same mechanism collapses the
> spilled *amounts* into a total, so the form's own arithmetic still
> reconciles. Dropping entries silently is never the default.

Now show `out/schedule-c-2025-filled.pdf` — the official Schedule C.

> Part II names twenty-four expense lines individually, so each one is bound by
> a filter on the line number the engine assigned. Part V is the only repeating
> region, and it runs down the page: same model, different step vector.
>
> And here is my favourite thing the real form taught me. Add up the eight
> printed rows in Part V and you get 10,119. Line 48 says 10,120. Line 48 is
> right — the IRS rule is to add the unrounded amounts and round only the
> total. If the annotation layer computed its own totals, it would have printed
> 10,119 on a filed return. That is the single best argument for the decision I
> was about to describe anyway, and there is a test pinning the discrepancy so
> nobody "fixes" it.

## 3:20 – 4:20 — The seam, and making it hold up

Terminal:

```bash
npm run demo
```

> The last three steps are the ones that matter. It compiles the template to
> a **render plan**, validates that file against its own schema, and then
> renders the PDF **from the plan alone** — no template, no data set in
> reach.

Show `out/schedule-c.plan.json`, then a placement in it.

> That is the interchange format. Every placement carries its own resolved
> font, alignment, padding and overflow policy, so a consumer never needs the
> template. The one thing it omits is font metrics, because those belong to
> whoever draws — and that omission is what lets two implementations be
> compared exactly. `conformance/plans/` holds golden plans and the suite
> asserts them byte-for-byte.
>
> Worth saying out loud: the first version of this got that wrong. The
> renderer reached back into the template for padding and overflow, which
> made the whole "print it with your own code" claim false. There is now a
> test that reads the renderer's source and fails if it mentions templates.

Point at the digest lines.

> Every template pins the SHA-256 of the exact PDF its coordinates were
> measured against. Forms get reissued mid-season and can move every box a few
> points while looking identical. With the digest that is one build failure
> instead of a whole filing run printed slightly wrong. Re-stamping is a
> separate command, because accepting a new digest means you re-checked.

```bash
npm test
```

> Ninety-one tests. The interesting one asserts that the printed rows plus the
> carried-over total equal the figure the form reports on line 28 — nothing can
> be lost in the overflow path.

Mention briefly:

> The form I was handed had been through a browser's print-to-PDF, which
> strips the AcroForm. The widget dictionaries survive though, so the importer
> falls back to walking those and recovered all 199 fields. And the five
> filing-status options turned out to share field names — only the appearance
> state tells them apart — so ids are derived from that, and a test asserts an
> imported draft never contains a duplicate id.

## 4:20 – 5:00 — Decisions and what is next

> The decision I would defend hardest: no expression language. A field cannot
> say `sum(wages) - adjustments`. Tax logic belongs in the calculation engine
> that also feeds e-filing and the summary screen; if the annotation layer
> computed totals too, the two would eventually disagree and the printed return
> would be the one that is wrong.
>
> Everything fails loudly by default — text that does not fit, rows that do not
> fit, a digest that does not match.
>
> One limitation I will state plainly: the form prints an "if more than four
> dependents, check here" box that is not a fillable field in this PDF. There
> was nothing to bind, so I left it out rather than guess a rectangle — an X on
> the wrong line of a tax return is worse than no X. I know that because
> `inspect` caught me binding it to the nonresident-alien checkbox.
>
> Next: a visual annotate-by-clicking tool for exactly that case, and template
> inheritance across tax years so 2026 only overrides what moved.

---

## If asked

- **Why JSON over XML?** Tax data already moves as JSON; JSON Schema is
  runnable by a reviewer; templates diff better across years. XML's advantage
  is MeF, which is a different serialisation problem.
- **Why not just use the PDF's AcroForm directly?** It gives rectangles, not
  meaning. It cannot say which nested value belongs in a box, how to format a
  loss, or what to do with a fifth dependent. `import` uses it as a starting
  point, which is the right amount of use — and on this form it was not even
  intact.
- **What breaks first at scale?** Hand-measuring coordinates for flat forms.
  That is why the visual authoring tool is first on the future list.

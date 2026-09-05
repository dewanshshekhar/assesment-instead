# Video walkthrough — running order

Five minutes, hard cap. The grading is on scope, cleanliness and the quality
of the walkthrough, so this is structured to demonstrate scope rather than
narrate the code.

Have open before recording: `SPEC.md`, `templates/us.irs.f1040sc.2024.json`,
`examples/sample-return.json`, `out/schedule-c-filled.pdf`, and a terminal in
`tools/`.

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

## 2:20 – 3:20 — Scope: what real forms actually do

Show `out/schedule-c-filled.pdf` full screen.

> SSN and EIN are combs — one character per ruled cell, 3‑2‑4 and 2‑7 grouping.
> Cell width is derived from the box, so moving the box recomputes nothing.
>
> Accounting method is a radio group; the linter rejects a group where two
> members could be marked.
>
> And Part II is the interesting one. This taxpayer has twelve expenses. The
> form has nine lines.

Scroll to the bottom of page 1, then to page 2.

> Eight print, the ninth carries the **total** of everything that spilled — so
> the form's own arithmetic still reconciles — and the spilled rows come out as
> a continuation statement. Dropping rows silently is never the default;
> overflow defaults to a hard error in both directions, for text and for rows.

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

> Seventy-seven tests. The interesting one asserts that the printed rows plus the
> carried-over total equal the figure the form reports on line 28 — nothing can
> be lost in the overflow path.

Mention briefly: `import` reads an official fillable PDF's AcroForm and drafts
the rectangles from the form itself.

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
> One limitation, stated plainly: the example coordinates are measured against
> generated fixture forms, not the official IRS PDFs, because I could not fetch
> them here. So the digests are real and the check genuinely passes, rather
> than being placeholder numbers.
>
> Next: a visual annotate-by-clicking tool, template inheritance across tax
> years so 2025 only overrides what moved, and a conformance suite — render
> plans carry no font metrics specifically so two implementations can be
> compared exactly.

---

## If asked

- **Why JSON over XML?** Tax data already moves as JSON; JSON Schema is
  runnable by a reviewer; templates diff better across years. XML's advantage
  is MeF, which is a different serialisation problem.
- **Why not just use the PDF's AcroForm directly?** It gives rectangles, not
  meaning. It cannot say which nested value belongs in a box, how to format a
  loss, or what to do with a twelfth expense. `import` uses it as a starting
  point, which is the right amount of use.
- **What breaks first at scale?** Hand-measuring coordinates for flat forms.
  That is why the visual authoring tool is first on the future list.

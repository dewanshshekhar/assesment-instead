# Video walkthrough

Five minutes, hard cap. Graded on scope, cleanliness and the quality of the
walkthrough, so every beat below shows something on screen rather than
describing it.

---

## Before you record

Run this once so nothing compiles on camera:

```bash
cd tools && npm install && npm run demo
```

Have these open, in this order, and nothing else:

| # | Window | What |
|---|--------|------|
| 1 | Terminal | in `tools/`, cleared |
| 2 | Editor | `SPEC.md`, `templates/us.irs.f1040sc.2025.json`, `examples/sample-return.json` |
| 3 | PDF | `out/f1040-2025-filled.pdf` |
| 4 | PDF | `out/schedule-c-2025-filled.pdf` (all 3 pages) |
| 5 | Browser | `out/browser-demo.html` |
| 6 | Browser | `out/annotation-editor.html` |

Terminal font 16pt or larger. Editor zoomed so a reviewer can read it on a
phone. Close Slack and notifications.

---

## 0:00 – 0:30 · What this is

*Show: the repository root.*

> A tax form is fixed paper with ruled boxes. A return is a deeply nested data
> structure. Something has to connect the two — and the brief says someone else
> builds the printing app with their own code.
>
> So the deliverable is a **specification**. `SPEC.md` is normative, there are
> three JSON Schemas, and everything under `tools/` is supporting material,
> including a renderer that exists only to prove the spec is implementable.

---

## 0:30 – 1:10 · Positioning and formatting, on a real form

*Show: `out/schedule-c-2025-filled.pdf` page 1, full screen. Point at the EIN, then the money column.*

> The official 2025 Schedule C, filled from a sample return. I typed no
> coordinates — the importer read them out of the PDF's own fields.
>
> Every field is a **rectangle**, not a point: x, y, width, height in points,
> top-left origin, with alignment and padding. A point cannot say
> "right-aligned against the cents rule" or "centred in this square".
>
> The EIN is a **comb** — one character per ruled cell, width derived from the
> box. Money is whole dollars, losses in parentheses, and a zero line stays
> blank. On a tax form, blank and zero are not the same thing.

---

## 1:10 – 2:00 · Reaching into the nested data

*Show: `examples/sample-return.json` beside the template. Point at a named expense line.*

> Canonical form is **RFC 6901 JSON Pointer** — a standard anyone can
> implement. On top, a small JSONPath subset for the two things a pointer
> cannot do: wildcards and filters.
>
> Part II names twenty-four expense lines, so each filters the return by its
> IRS line number. A reference selecting more than one node **requires** an
> explicit aggregate — silently taking the first of two W-2s is how a wrong
> number reaches a filed return.

*Scroll to `bindings`. Then run `npm run render:alt`.*

> One level up: a field names a **concept**, not a path. `bindings` is the only
> place this template touches data shape.
>
> Same template, unedited. A completely different return shape, only the
> binding profile swapped — and the output is **byte-identical**.

---

## 2:00 – 2:50 · Scope: what real forms do

*Show: `out/f1040-2025-filled.pdf`, the dependents block.*

> These four dependents are **columns**, not rows. My first repeat model had a
> `rowHeight`, which cannot describe that. It is a step **vector** now:
> dependents are 108 across, Part V is 24 down.

*Show: Schedule C page 1 bottom, then page 3. Point at Part V, then line 48.*

> Eleven other-expenses, nine rows. Eight print, the ninth carries the spilled
> total so the form's arithmetic reconciles, and the rest go on a continuation
> statement.
>
> And my favourite thing the form taught me. Add the printed rows and the
> carry-over: **ten thousand one hundred nineteen**. Line 48 says **twenty**.
> Line 48 is right — the IRS rule is to add unrounded amounts and round only
> the total. A template computing its own totals would have printed the wrong
> number on a filed return. A test pins that discrepancy so nobody "fixes" it.

---

## 2:50 – 3:35 · The seam someone else plugs into

*Terminal: `npm run plan && npm run check-plan`. Then open `out/browser-demo.html` and toggle "Show placement boxes".*

> A template compiles to a **render plan**: every value resolved, formatted and
> placed, each placement carrying its own font, alignment, padding and overflow
> policy. It omits font metrics, because those belong to whoever draws.
>
> Here is the proof rather than the claim. This page is a **second
> implementation** — plain JavaScript, no library, sharing no code with my
> renderer. It reads that plan and fills the same form.
>
> The first version got this wrong: my renderer reached back into the template
> for padding, which made the claim false. There is now a test that reads the
> renderer's source and fails if it mentions templates.

---

## 3:35 – 4:15 · Making it hold up

*Terminal: `npm test`. Then open `out/annotation-editor.html`, click a box, nudge with arrows.*

> Ninety-nine tests. Golden render plans asserted byte-for-byte, and
> byte-reproducible output.
>
> Every template pins the **SHA-256** of the PDF its coordinates came from.
> Forms get reissued and can move every box a few points while looking
> identical — with the digest that is one build failure instead of a whole
> filing run printed slightly wrong.
>
> Annotating is not JSON editing: drag, nudge by a point, shift-drag to draw a
> box the PDF never declared. And the form I was handed had its AcroForm
> stripped by a browser print-to-PDF — the importer falls back to the surviving
> widgets and recovered all 199 fields.

---

## 4:15 – 5:00 · Decisions, and what is next

> The decision I would defend hardest: **no expression language**. A field
> cannot say `sum(wages) minus adjustments`. Tax logic belongs in the engine
> that also feeds e-filing; if this layer computed totals too, the two would
> disagree — and line 48 is what that looks like in practice.
>
> Everything fails loudly by default: text that does not fit, rows that do not
> fit, a digest that does not match.
>
> One limitation. Form 1040 prints an "if more than four dependents" check that
> is not a fillable field, so I left it unbound rather than guess a rectangle —
> an X on the wrong line is worse than no X. I know that because the inspector
> caught me binding it to the wrong box.
>
> Next: template inheritance across tax years, and a published conformance
> corpus so a third-party renderer can self-certify.

---

## Pace, honestly

The spoken script is **754 words**. That is 5:02 at a brisk 150 words a
minute, and about 5:25 at a comfortable pace — so it only fits if you keep
moving. Do not slow down to sound thoughtful; the brief says max five minutes
and an overrun is the first thing a reviewer notices.

**Checkpoints.** Glance at the timer at each section change:

| By | You should be | If you are behind |
|----|---------------|-------------------|
| 0:30 | starting the filled Schedule C | skip "three JSON Schemas" |
| 1:10 | opening the sample return | skip the padding clause |
| 2:00 | on the 1040 dependents block | cut "unedited" and the profile aside |
| 2:50 | running `npm run plan` | drop the continuation sentence, keep line 48 |
| 3:35 | running `npm test` | drop the annotation-editor beat entirely |
| 4:15 | on decisions | drop the AcroForm-recovery sentence |

**The three sentences to drop first**, in order — each is a clean cut that
leaves no dangling reference:

1. The annotation-editor paragraph at 3:50 (repo shows it)
2. The AcroForm-recovery sentence at 4:05
3. The digest paragraph at 3:45

**Never cut:** line 48 and the rounding rule, the second implementation, and
"the first version got this wrong". Those three are what separate this from a
feature tour.

## If you finish early

- Open `SPEC.md` §11 and show the render plan shape
- `npm run lint` — three templates, zero errors, zero warnings
- Show `conformance/plans/` and say what a golden plan is for

## Recording notes

- One take, no editing. A small stumble reads as human; a cut reads as staged.
- Never read a slide. Every beat has something on screen — point at it.
- Do not explain what a tax form is. Assume the reviewer knows their product.
- Say numbers out loud: "ten thousand one hundred nineteen", not "this number".
- If you overrun, stop at 5:00 mid-sentence rather than rushing the ending. The
  brief says max five minutes and they will notice.

## If asked

- **Why JSON over XML?** Tax data already moves as JSON, JSON Schema is
  runnable by a reviewer, and templates diff better across years. XML's
  advantage is MeF, which is a different serialisation problem.
- **Why two reference syntaxes?** Pointer is the standard and the canonical
  form; the JSONPath subset exists because a pointer cannot say "the Schedule C
  whose id is biz-1", and templates need to say that constantly.
- **`aggregate: sum` is computation — isn't that a contradiction?** It restates
  a total the data already contains, element by element. It introduces no rule
  that exists nowhere else. Line 48 is the line I would not let a template
  compute.
- **Why not use the PDF's AcroForm directly?** It gives rectangles, not
  meaning. It cannot say which nested value belongs in a box, how to format a
  loss, or what to do with a twelfth expense. And on this form it was not even
  intact.
- **What breaks first at scale?** Hand-measuring boxes for flat or scanned
  forms. The editor helps; a form rasterised to an image has nothing to recover.

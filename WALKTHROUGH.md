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

## The script

Read it straight through. `[ ]` lines are what you do; everything else is what
you say, word for word.

---

### 0:00 — Opening

**[Screen: the repository root.]**

Hi, I'm Dewansh. This is my submission for the Instead technical test.

The brief says someone else builds the printing application, in their own code.
So what I built is a specification, not a renderer.

`SPEC.md` is normative, with three JSON Schemas; everything under `tools/` only
exists to prove it can be implemented.

---

### 0:25 — Positioning and formatting

**[Open `out/schedule-c-2025-filled.pdf`, page 1, full screen.]**

The official 2025 Schedule C, filled from a sample return. I didn't type a
single coordinate — the importer read them out of the PDF's own form fields.

Every field is a rectangle, not a point: x, y, width, height in points,
top-left origin, plus alignment and padding. A point can't say "right-aligned
against the cents rule" — which is exactly what a form needs.

**[Point at the EIN box, then the money column.]**

The EIN is a comb field — one character per ruled cell. Money is whole dollars,
losses print in parentheses, and a zero line stays blank: on a tax form, blank
and zero don't mean the same thing.

---

### 1:10 — Referencing a nested value

**[Open `examples/sample-return.json` beside the template.]**

Now, reaching into a deeply nested return.

**[Point at a named expense line in the template.]**

The canonical form is RFC 6901 JSON Pointer, a standard anyone can implement.
On top of that, a small JSONPath subset for the two things a pointer can't do:
wildcards and filters. That's how each of Part Two's twenty-four expense lines
finds its own line in the return.

And a reference that selects more than one node must say how to aggregate them,
or it's an error. Silently taking the first of two W-2s is how a wrong number
reaches a filed return.

**[Scroll to `bindings` at the top of the template.]**

One level up, a field names a concept, not a path — and this block is the only
place the template knows the data's shape.

**[Terminal: `npm run render:alt`]**

Same template, unedited. A completely different return shape. I swapped only
the binding profile — byte-identical output.

---

### 2:05 — What real forms actually do

**[Open `out/f1040-2025-filled.pdf`, dependents block.]**

Form 1040. These four dependents are columns, not rows — the fields run down
inside one dependent, and the next dependent moves right. My first repeat model
had a row height, which can't describe that. It's a step vector now: a hundred
and eight across here, twenty-four down in Part Five.

**[Schedule C page 1, bottom. Then page 3.]**

Eleven other-expenses, nine rows. Eight print, the ninth carries the spilled
total, and the rest go to a continuation statement.

**[Point at Part V, then line 48.]**

My favourite thing the real form taught me. Add the printed rows and the
carry-over: ten thousand one hundred nineteen. Line 48 says ten thousand one
hundred twenty.

Line 48 is right. The IRS rule is to add the unrounded amounts and round only
the total. A layer that computed its own totals would have printed the wrong
number on a filed return. A test pins that difference so nobody "fixes" it.

---

### 3:05 — The seam someone else plugs into

**[Terminal: `npm run plan && npm run check-plan`]**

A template compiles to a render plan: every value resolved, formatted and
placed, each placement carrying its own font, alignment, padding and overflow
policy — so a consumer never reads the template at all.

**[Open `out/browser-demo.html`. Toggle "Show placement boxes".]**

Here's the proof. This page is a second implementation — plain JavaScript, no
library, sharing no code with my renderer. It reads that plan and fills the
same form.

I'll be honest: the first version got this wrong — my renderer reached back
into the template for padding, which made the whole claim false. There's now a
test that fails if the renderer's source even mentions templates.

---

### 3:45 — Making it hold up

**[Terminal: `npm test`]**

Ninety-nine tests. Golden render plans asserted byte for byte, and the output
is byte-reproducible.

Every template pins the SHA-256 of the PDF its coordinates came from. Forms get
reissued mid-season with boxes moved a few points. The digest turns that into
one build failure instead of a filing run printed wrong.

**[Open `out/annotation-editor.html`. Click a box, nudge with arrow keys.]**

And annotating isn't JSON editing — drag to move, arrow keys nudge a point at a
time, shift-drag draws a box the PDF never declared.

---

### 4:20 — Decisions, and what's next

**[Screen: `DECISIONS.md`.]**

The decision I'd defend hardest: no expression language. A field cannot say
"sum of wages minus adjustments". Tax logic belongs in the calculation engine —
the same one that feeds e-filing. If this layer computed totals too, the two
would eventually disagree — and line 48 is what that looks like.

One limitation, plainly: the 1040's "more than four dependents" checkbox isn't
a fillable field in that PDF, so I left it unbound. An X on the wrong line is
worse than no X.

Next would be template inheritance across tax years, and a conformance corpus
third-party renderers can certify against.

Thanks for watching.

---

## Pace, honestly

The spoken script is **706 words** — 4:42 at 150 words a minute, a little over
five minutes at a relaxed 140. So it fits, but only if you keep moving. Do not
slow down to sound thoughtful; the brief says max five minutes and an overrun
is the first thing a reviewer notices.

**Checkpoints.** These are the measured section starts. Glance at the timer at
each one:

| By | You should be | If you are behind |
|----|---------------|-------------------|
| 0:25 | on the filled Schedule C | skip "three JSON Schemas" |
| 1:10 | opening the sample return | skip the comb sentence |
| 2:05 | on the 1040 dependents block | cut "unedited" and the profile aside |
| 3:05 | running `npm run plan` | drop the continuation sentence, keep line 48 |
| 3:45 | running `npm test` | drop the annotation-editor beat |
| 4:20 | on decisions | drop the digest paragraph |

**The three things to drop first**, in order — each is a clean cut that leaves
no dangling reference:

1. The annotation-editor paragraph at 4:05 (the repo shows it anyway)
2. The digest paragraph at 3:50
3. The "one limitation" paragraph at 4:45

**Never cut:** line 48 and the rounding rule, the second implementation, and
"the first version got this wrong". Those three are what separate this from a
feature tour.

## If you finish early

- Open `SPEC.md` §11 and show the render plan shape
- `npm run lint` — three templates, zero errors, zero warnings
- Show `conformance/plans/` and say what a golden plan is for
- Mention the AcroForm recovery: the 1040 I was given had its form dictionary
  stripped by a browser print-to-PDF, and the importer fell back to the raw
  widgets to recover all one hundred and ninety-nine fields

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
- **Did you guess any coordinates?** Only where the PDF gave none. The EIN comb
  and the business-code box were measured off the rasterised blank form, not
  eyeballed — nine uniform cells, no gap.
- **What breaks first at scale?** Hand-measuring boxes for flat or scanned
  forms. The editor helps; a form rasterised to an image has nothing to recover.

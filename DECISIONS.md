# Decisions and trade-offs

What was chosen, what was rejected, and what I would build next.

---

## 1. Decisions

### 1.1 JSON, not XML

Tax data already moves as JSON in most modern stacks, JSON Schema gives the
specification a machine-checkable form that a reviewer can run, and every
language parses it without ceremony.

XML would have brought XSD and a mature validation story, and it is what MeF
speaks. It was rejected because a template is authored and reviewed by
people, and the JSON version of the same document is meaningfully shorter and
easier to diff across tax years.

**Cost:** JSON has no comment syntax, so the schema explicitly permits a
`$comment` string wherever an author would want one.

### 1.2 Rectangles, not points

The obvious model is `{field, x, y}`. It cannot express right-aligned
currency, a centred checkmark, or "shrink this to fit", because none of those
are decidable without knowing the box.

Rect-plus-alignment costs two extra numbers per field and removes an entire
class of "the number overlaps the ruling" bugs.

### 1.3 Top-left origin

PDF user space is bottom-left. Everything a human uses to measure a
form — a screen, a browser, a design tool — is top-left. Version 1 fixes
top-left and does the flip once at draw time (§3.1). Authors never invert a
number by hand, and there is exactly one line of code where the mistake could
be made.

### 1.4 Declarative references, not an expression language

The tempting design lets a field say `sum(w2.wages) - adjustments`. It was
rejected.

- An expression language turns templates into a second place where tax logic
  lives, and two implementations of one rule eventually disagree.
- Every implementer must then reimplement an evaluator identically, which is
  where subtle divergence between renderers begins.
- Evaluating user-authored expressions is a security surface.

Instead: reference, aggregate, transform, fallback, default — a total,
side-effect-free pipeline (SPEC §5, §6). `aggregate: "sum"` is the one
concession, and it only restates a total the data already contains.

**Cost:** anything genuinely computed must exist in the data set first. That
is the intended pressure — it pushes tax logic into the engine that owns it.

### 1.5 JSON Pointer as canonical, JSONPath-lite as sugar

Pointer is a published standard, unambiguous, and implementable in a dozen
lines. But a pointer cannot say "the Schedule C whose id is biz-1", and that
is a thing templates need to say constantly.

So both, with one resolver. The JSONPath subset is deliberately tiny (no
recursive descent, no slices, no arithmetic, `==` and `!=` only) so a third
party can reimplement it faithfully in an afternoon. A large subset would
have been a liability: every operator is a compatibility promise.

### 1.6 Bindings instead of per-copy templates

One Schedule C per business, one Schedule E per property. Rather than
generating a template per copy, a template declares a binding and every `@`
reference hangs off it (SPEC §5.4). Printing the second business changes one
line. The tests demonstrate exactly this.

### 1.7 Failing loudly by default

Both `overflow` settings default to `error`:

- text wider than its box → do not draw, report it;
- more rows than the form provides → do not render, report it.

Truncation and continuation are available, but they must be requested. On a
tax return, a silently dropped expense or a clipped digit is worse than a
build failure. Every diagnostic carries a code and an entry id so a pipeline
can decide what to do.

### 1.8 Digest-pinning the source PDF

`source.sha256` (SPEC §12) ties a set of coordinates to the exact PDF they
were measured against. Forms get reissued mid-season, and a reissued PDF can
move every box a few points while looking identical. Without the digest that
surfaces as subtly wrong output across a whole filing run; with it, it
surfaces as one build error. Re-stamping is a separate, explicit command
because accepting a new digest asserts that the coordinates were re-checked.

### 1.9 Plan and draw as separate stages

Resolution produces a `RenderPlan` of plain placements with no font metrics;
drawing consumes it (SPEC §11). The assessment states that a third party
builds the printing application with their own code, so the plan is the seam
they plug into. It also means text measurement — the one thing that genuinely
differs between implementations — is isolated in the stage that owns the
fonts.

### 1.10 The render plan is a versioned interchange format, not an internal detail

The first version of this treated the plan as an implementation detail: the
renderer built one, then reached back into the template for padding,
vertical alignment and overflow policy. That made SPEC §11's claim — that a
host application can draw from a plan with its own code — quietly false. A
third party holding only a plan could not have drawn a correct page.

So the plan is now a first-class artefact: its own schema, its own version
number, and a hard self-containment rule (SPEC §11.2). Every presentation
property is resolved and present on the placement, so no consumer ever
applies a default of its own.

`planVersion` is deliberately **separate from `specVersion`**. The two change
for different reasons and are consumed by different people: a new field type
is a template-format change that a renderer never sees, so a renderer should
not be forced to re-certify against it.

The regression guard is a test that reads `render.ts` and fails if it
mentions templates at all.

**Cost:** placements are more verbose, and the same padding is repeated on
many of them. That is the right trade — the redundancy is what removes the
ambiguity.

### 1.11 Output is byte-reproducible

PDF writers stamp a modification time on save, so two identical runs produced
different files. The metadata is now pinned, and rendering the same plan onto
the same PDF twice yields identical bytes.

That buys caching, meaningful diffs between two runs, and golden-file
regression testing — all worth having when the artefact is a tax return. The
filing timestamp belongs to the return data, not to document metadata, and a
caller that genuinely wants a live one can pass it.

### 1.12 Conformance by golden plan, not by golden image

Because plans carry no font metrics and no implementation-defined defaults,
two implementations can be compared *exactly*. `conformance/plans/` holds a
golden plan per template and the suite asserts a byte-for-byte match.

Pixel comparison was the alternative. It catches more — a box that moved two
points — but it is fragile across font versions and rasterisers, and it
cannot tell a third-party implementer *which* value they got wrong. Golden
plans answer that precisely. Image comparison is still worth adding on top;
see §4.5.

### 1.13 Base-14 fonts only in version 1

No font files travel with a template and every PDF implementation already has
these. Embedded fonts are a version 1.1 question (§4.4 below), and answering
it needs licensing decisions that a specification should not make on the
reader's behalf.

### 1.14 `additionalProperties: false` everywhere

A misspelled `alignment` is a silent no-op in a permissive schema and a
caught error in a strict one. Strictness now is what makes it safe to add
properties later.

---

## 2. Things this deliberately does not do

| Not done | Why |
|----------|-----|
| Tax calculation | Belongs to the calculation engine; two implementations of one rule will diverge (SPEC §1.2, §5.6) |
| Data-set schema | The template adapts to the data, not the reverse |
| Reading values back out of a filled PDF | A different problem (extraction), and a different specification |
| Locale/i18n | U.S. forms only in version 1; see §4.6 |
| Digital signatures | Orthogonal to placement |

---

## 3. Known limitations

1. **The example coordinates are measured against generated fixtures, not
   the official IRS PDFs.** This environment has no network access to
   irs.gov, and redistributing IRS PDFs into a repository is a separate
   question. Rather than invent plausible-looking coordinates and a fake
   digest, the examples target two forms generated by
   `tools/src/fixtures.ts`, laid out like the real thing. Their digests are
   real and the digest check genuinely passes. `cli.ts import` is the path
   to a production template: run it against the official PDF and the
   rectangles come from the form itself.

2. **`import` depends on the PDF having an AcroForm.** Flat or scanned forms
   still need manual measurement; a visual authoring tool (§4.1) is the
   answer.

3. **Continuation statements are described, not typeset.** The specification
   defines the data contract; how a statement is laid out is the host
   application's decision. The reference renderer appends a plain table to
   show the contract works.

4. **No right-to-left or vertical text.** Out of scope for U.S. forms.

5. **`wrap` uses greedy line breaking.** Adequate for a form's explanation
   boxes; not a typesetting engine.

6. **Golden plans prove agreement, not correctness of placement.** They
   confirm two implementations put the same string in the same rectangle;
   they cannot confirm the rectangle is where the form's box actually is.
   Only rendering and looking — or §4.5 — does that.

---

## 4. Future enhancements

### 4.1 Visual annotation authoring
A browser tool that renders the form and lets an author drag a box onto it,
emitting the JSON. Measuring coordinates by hand is the slowest part of
producing a template, and the format is already designed for a tool to write.

### 4.2 Template inheritance and cross-year diffing
Most of Form 1040 does not move between tax years. A 2025 template should be
able to declare `extends: "us.irs.f1040.2024"` and override only what moved,
with a diff report showing exactly which boxes changed. That turns the annual
re-annotation from a rewrite into a review.

### 4.3 Deterministic drift detection
When a form is reissued, compare the old and new AcroForm rectangles
automatically and report which fields moved and by how much. Combined with
the digest check, re-calibration becomes mechanical rather than a hunt.
Purely deterministic — no image comparison, no inference.

### 4.4 Embedded and substituted fonts
A `fonts` block declaring embedded font files, with a documented fallback
chain. Needed for any agency form that requires a specific typeface.

### 4.5 Golden-image regression tests
Golden plans (§1.12) prove two implementations resolved the same values into
the same boxes. They cannot prove the boxes are in the right place on the
paper. Rasterising each rendered form and pixel-diffing against a committed
reference image would catch a box that moved two points — the one class of
error that survives every check currently in the repository.

### 4.6 A second jurisdiction
State forms would exercise the parts of the model that are quietly
U.S.-federal-shaped: `ombNumber`, whole-dollar defaults, the parentheses
convention for negatives. Adding one state would show which of those belong
in a `conventions` block instead of being hard-coded defaults.

### 4.7 MeF mapping alongside print
The same reference expressions could carry an `efile` binding to the MeF XML
element for that line, so print and electronic filing are proven to be
reading the same value from the same place, rather than being two
independent traversals of the return.

### 4.8 Publishing the conformance corpus
The mechanism exists (§1.12): golden plans, asserted byte-for-byte. What is
missing is breadth and packaging — a corpus covering every field type,
formatting rule and overflow path, distributed separately from this
implementation, with a runner a third party can point at their own renderer
to self-certify.

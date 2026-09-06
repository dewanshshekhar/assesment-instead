# Tools

Supporting implementation for the Tax Form Annotation Specification.

**None of this is part of the specification.** The specification is `SPEC.md`
and `spec/annotation-template.schema.json` at the repository root. A host
application is expected to consume a render plan (SPEC §11) and draw with its
own stack; this reference implementation exists to prove the specification is
implementable and to give the examples something to draw with.

The core — reference resolution, value evaluation, formatting, geometry — has
no dependencies at all. Only the PDF-touching parts need `pdf-lib`, and only
the schema check needs `ajv`.

## Layout

| File | Purpose | Dependencies |
|------|---------|--------------|
| `src/reference.ts` | JSON Pointer + JSONPath-lite parsing and resolution | none |
| `src/value.ts` | reference → aggregate → transform → fallback → default | none |
| `src/format.ts` | formatted output, with scaled-integer money rounding | none |
| `src/layout.ts` | rect maths, comb cell derivation, alignment, wrapping | none |
| `src/plan.ts` | template + data → render plan | none |
| `src/conformance.ts` | golden-plan cases, shared by tests and the updater | none |
| `src/lint.ts` | schema and semantic validation | `ajv` |
| `src/render.ts` | render plan → PDF | `pdf-lib` |
| `src/import.ts` | AcroForm → draft template | `pdf-lib` |
| `src/fixtures.ts` | generates the example blank forms | `pdf-lib` |
| `src/update-conformance.ts` | regenerates the golden plans | |
| `src/browser-demo.ts` | builds a self-contained browser consumer of a plan | |
| `src/cli.ts` | command line entry point | |

TypeScript runs directly on Node 22.6+ via type stripping; there is no build
step and no transpiler config.

## Commands

```bash
npm install
npm run demo      # fixtures, lint, render, compile a plan, check it, draw from it
npm test          # 99 tests
```

Or directly:

```bash
node --experimental-strip-types src/cli.ts <command> [options]
```

| Command | What it does |
|---------|--------------|
| `fixtures [--out dir]` | Generate the example blank forms and print their digests |
| `lint <template...> [--data f] [--bindings f] [--strict-data]` | Validate against the schema and the semantic rules; with `--data`, also build a plan; `--strict-data` additionally reports references that select nothing |
| `plan <template> --data f [--bindings f] [--out f]` | Compile a template to a render plan |
| `check-plan <plan.json...>` | Validate a plan against `spec/render-plan.schema.json`, the way a consumer would before drawing it |
| `render <template> --data f --out f.pdf` | Compile and draw in one step |
| `render --plan f.json --out f.pdf` | Draw from a serialised plan, with no template in reach |
| `import <pdf> --id <id> --out f.json` | Read a fillable PDF's form fields and emit a draft template |
| `inspect <template> --out f.pdf` | Print each field's id inside its own box, to check bindings against the paper |
| `stamp <template> [--source f.pdf]` | Re-record `source.sha256` after a form is reissued |

## Producing a template for a real form

```bash
# 1. Draft the rectangles from the official PDF's own form fields.
node --experimental-strip-types src/cli.ts import ./f1040.pdf \
  --id us.irs.f1040.2025 --title "Form 1040" --tax-year 2025 \
  --revision 2025-12 --out ../templates/us.irs.f1040.2025.json

# 2. Bind each field to the data set. Every value.ref is emitted as a TODO,
#    because the PDF's own field names are not the names you want.

# 3. Check it, against real data.
node --experimental-strip-types src/cli.ts lint \
  ../templates/us.irs.f1040.2025.json --data ../examples/sample-return.json

# 4. Render and look at the result. The linter cannot tell you that a box is
#    in the right place, only that it is on the page.
node --experimental-strip-types src/cli.ts render \
  ../templates/us.irs.f1040.2025.json --data ../examples/sample-return.json \
  --out ../out/check.pdf --source ./f1040.pdf
```

### Two import strategies

`import` reports which one it used.

| Strategy | When |
|----------|------|
| `acroform` | The catalog's AcroForm is intact. The normal case. |
| `widgets` | The AcroForm entry is gone but the widget annotations survive. Copies of official forms that have been through a browser's print-to-PDF arrive like this — the catalog entry and the pages' `/Annots` arrays are dropped, leaving the widget dictionaries orphaned but complete, each still naming its page through `/P`. |

Both official forms in `forms/` are `widgets` cases — 199 fields on Form 1040
and 105 on Schedule C, fully recoverable, none of which anyone had to measure.

A truly flat or scanned form still has to be measured by hand.

### Checking the bindings

An imported draft names its fields the way the PDF does. `f1_16[0]` says
nothing about which line it is, so:

```bash
node --experimental-strip-types src/cli.ts inspect draft.json \
  --source ../forms/f1040-2025.pdf --out ../out/labelled.pdf
```

prints each id inside its own box. Open it next to the blank form and read off
which id belongs to which line. That is how both official templates were bound,
and it is what caught a checkbox mapped to the wrong line and an EIN comb whose
cell width was wrong.

## Binding profiles

A template whose fields name concepts reads its data through `bindings`. A
profile passed with `--bindings` overrides them, which is how one form prints
from a differently shaped return:

```bash
npm run render:alt    # us.irs.f1040sc.2025 against examples/alt-shape-return.json
```

A profile is refused when its `for` names another template or its `model`
differs from the template's — applying the wrong one would bind concepts to
the wrong values and the output would look entirely plausible.

## The browser consumer

```bash
npm run demo:browser     # -> out/browser-demo.html
```

A self-contained page that fills Schedule C from the render plan with its own
JavaScript. It is deliberately a *separate implementation*: it imports nothing
from `src/`, and knows nothing about templates, references or formatting. If a
change to the plan format breaks it, the plan stopped being self-sufficient.

## Conformance

`conformance/plans/` holds a golden render plan for each example template,
and the test suite asserts the compiled plan matches byte-for-byte. A change
to resolution, formatting or geometry therefore shows up as a reviewable diff
rather than as a silently different tax form.

```bash
npm run conformance:update   # regenerate, then read the diff
```

Regenerate deliberately. The goldens are the contract every consumer draws
from, and they are also what a third-party implementation compares itself
against — plans carry no font metrics precisely so that agreement can be
exact.

## When a form is reissued

`render` refuses to draw when the source PDF's digest does not match the
template (SPEC §12). That is the intended behaviour: a reissued form can move
every box a few points while looking identical.

```bash
node --experimental-strip-types src/cli.ts stamp ../templates/us.irs.f1040.2025.json
```

Stamping is a separate command on purpose. Accepting a new digest asserts
that the coordinates were re-checked against the new PDF — so re-render and
look at the output before trusting it.

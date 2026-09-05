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
| `src/lint.ts` | schema and semantic validation | `ajv` |
| `src/render.ts` | render plan → PDF | `pdf-lib` |
| `src/import.ts` | AcroForm → draft template | `pdf-lib` |
| `src/fixtures.ts` | generates the example blank forms | `pdf-lib` |
| `src/cli.ts` | command line entry point | |

TypeScript runs directly on Node 22.6+ via type stripping; there is no build
step and no transpiler config.

## Commands

```bash
npm install
npm run demo      # fixtures + lint + render, end to end
npm test          # 61 tests
```

Or directly:

```bash
node --experimental-strip-types src/cli.ts <command> [options]
```

| Command | What it does |
|---------|--------------|
| `fixtures [--out dir]` | Generate the example blank forms and print their digests |
| `lint <template...> [--data f]` | Validate against the schema and the semantic rules; with `--data`, also resolve every reference and build a plan |
| `plan <template> --data f [--out f]` | Print the resolved render plan as JSON |
| `render <template> --data f --out f.pdf [--source f.pdf] [--ignore-digest]` | Draw the plan onto the source PDF and append any continuation statements |
| `import <pdf> --id <id> --out f.json` | Read a fillable PDF's AcroForm and emit a draft template |
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

`import` needs the PDF to carry an AcroForm. Flat or scanned forms still have
to be measured by hand.

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

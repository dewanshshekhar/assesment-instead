#!/usr/bin/env node
/**
 * Command line entry point.
 *
 *   fixtures [--out dir]                       generate the example blank forms
 *   lint <template...> [--data f] [--bindings f] [--strict-data]  validate templates
 *   plan <template> --data f [--bindings f] [--out f]   compile to a render plan
 *   check-plan <plan.json>                     validate a plan against its schema
 *   render (<template> --data f | --plan f) --out f.pdf
 *   import <pdf> --id ... --out f.json         draft a template from an AcroForm
 *   inspect <template> --out f.pdf             overlay field ids onto the form
 *   stamp <template> [--source f.pdf]          re-record the source PDF's digest
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import type { AnnotationTemplate, BindingProfile, Diagnostic, RenderPlan } from "../../spec/types.ts";
import { buildPlan } from "./plan.ts";
import { lint } from "./lint.ts";
import { render, appendStatements, sha256 } from "./render.ts";
import { importAcroForm } from "./import.ts";
import { buildForm1040 } from "./fixtures.ts";
import type { Json } from "./reference.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_SCHEMA = resolvePath(HERE, "../../spec/annotation-template.schema.json");
const PLAN_SCHEMA = resolvePath(HERE, "../../spec/render-plan.schema.json");
const ROOT = resolvePath(HERE, "../..");
const FIXTURE_DIR = resolvePath(HERE, "../fixtures");
/** Official forms live at the repository root; the generated ones under tools/. */
const SOURCE_DIRS = [resolvePath(ROOT, "forms"), FIXTURE_DIR];

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function writeOut(path: string, bytes: Uint8Array | string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
}

function has(args: string[], name: string): boolean {
  return args.includes(`--${name}`);
}

function positional(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i].startsWith("--")) i += 1;
    else out.push(args[i]);
  }
  return out;
}

/**
 * Loads a binding profile, refusing one written for another template: applying
 * the wrong profile would bind concepts to values from the wrong return shape,
 * and the output would look plausible.
 */
async function loadBindings(
  args: string[],
  template?: AnnotationTemplate,
): Promise<Record<string, never> | BindingProfile["bindings"]> {
  const path = flag(args, "bindings");
  if (!path) return {};

  const profile = await readJson<BindingProfile>(path);
  if (template && profile.for !== "*" && profile.for !== template.template.id) {
    throw new Error(
      `binding profile is written for '${profile.for}' but the template is '${template.template.id}'`,
    );
  }
  if (template?.model && profile.model.id !== template.model.id) {
    throw new Error(
      `binding profile targets model '${profile.model.id}' but the template uses '${template.model.id}'`,
    );
  }
  return profile.bindings;
}

function report(label: string, diagnostics: Diagnostic[]): number {
  const errors = diagnostics.filter((d) => d.severity === "error");
  const warnings = diagnostics.filter((d) => d.severity === "warning");

  for (const d of diagnostics) {
    const where = d.entryId ? ` ${d.entryId}` : "";
    process.stdout.write(`  ${d.severity === "error" ? "error" : "warn "} [${d.code}]${where}: ${d.message}\n`);
  }
  process.stdout.write(`  ${label}: ${errors.length} error(s), ${warnings.length} warning(s)\n`);
  return errors.length;
}

/**
 * Locates the blank form a template or plan was measured against. The digest
 * check is what guarantees the right file was found, so searching a couple of
 * known directories is safe.
 */
function findSourcePdf(filename: string): string {
  for (const dir of SOURCE_DIRS) {
    const candidate = resolvePath(dir, filename);
    if (existsSync(candidate)) return candidate;
  }
  return resolvePath(SOURCE_DIRS[0], filename);
}

// ---------------------------------------------------------------------------

async function cmdFixtures(args: string[]): Promise<number> {
  const dir = flag(args, "out") ?? FIXTURE_DIR;

  const forms: [string, Uint8Array][] = [["f1040-p1.pdf", await buildForm1040()]];

  for (const [name, bytes] of forms) {
    await writeOut(resolvePath(dir, name), bytes);
    process.stdout.write(`${name}  ${bytes.length} bytes  sha256 ${sha256(bytes)}\n`);
  }
  return 0;
}

async function cmdLint(args: string[]): Promise<number> {
  const templates = positional(args);
  if (templates.length === 0) throw new Error("lint requires at least one template path");

  const dataPath = flag(args, "data");
  const data = dataPath ? await readJson<Json>(dataPath) : undefined;
  const schema = await readJson<unknown>(TEMPLATE_SCHEMA);

  let errors = 0;
  for (const path of templates) {
    const template = await readJson<AnnotationTemplate>(path);
    const bindings = await loadBindings(args, template);
    process.stdout.write(`\n${template.template.id}  (${path})\n`);
    errors += report("lint", lint(template, { data, schema, bindings, strictData: has(args, "strict-data") }));
  }
  return errors === 0 ? 0 : 1;
}

async function cmdPlan(args: string[]): Promise<number> {
  const [templatePath] = positional(args);
  const dataPath = flag(args, "data");
  if (!templatePath || !dataPath) throw new Error("plan requires <template> --data <file>");

  const template = await readJson<AnnotationTemplate>(templatePath);
  const data = await readJson<Json>(dataPath);
  const plan = buildPlan(template, data, { bindings: await loadBindings(args, template) });

  const out = flag(args, "out");
  const json = `${JSON.stringify(plan, null, 2)}\n`;
  if (out) {
    await writeOut(out, json);
    process.stdout.write(`\n${plan.templateId} -> ${out}\n`);
    process.stdout.write(`  ${plan.placements.length} placement(s), ${plan.statements.length} statement(s)\n`);
  } else {
    process.stdout.write(json);
  }
  return plan.diagnostics.some((d) => d.severity === "error") ? 1 : 0;
}

/**
 * Validates a plan on its own, the way a third-party consumer would before
 * drawing it. Nothing about the template is consulted.
 */
async function cmdCheckPlan(args: string[]): Promise<number> {
  const paths = positional(args);
  if (paths.length === 0) throw new Error("check-plan requires at least one plan path");

  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validate = ajv.compile(await readJson<object>(PLAN_SCHEMA));

  let failures = 0;
  for (const path of paths) {
    const plan = await readJson<RenderPlan>(path);
    process.stdout.write(`\n${plan.templateId ?? path}  (${path})\n`);

    if (validate(plan)) {
      process.stdout.write(
        `  plan v${plan.planVersion}: valid — ${plan.placements.length} placement(s), ` +
          `${plan.statements.length} statement(s), ${plan.diagnostics.length} diagnostic(s)\n`,
      );
    } else {
      failures += 1;
      for (const error of validate.errors ?? []) {
        process.stdout.write(`  error [plan/invalid] ${error.instancePath || "/"}: ${error.message}\n`);
      }
    }
  }
  return failures === 0 ? 0 : 1;
}

async function cmdRender(args: string[]): Promise<number> {
  const outPath = flag(args, "out");
  if (!outPath) throw new Error("render requires --out <file.pdf>");

  const planPath = flag(args, "plan");
  let plan: RenderPlan;

  if (planPath) {
    // Drawing straight from a serialised plan, with no template in reach.
    plan = await readJson<RenderPlan>(planPath);
  } else {
    const [templatePath] = positional(args);
    const dataPath = flag(args, "data");
    if (!templatePath || !dataPath) {
      throw new Error("render requires <template> --data <file>, or --plan <file.json>");
    }
    const template = await readJson<AnnotationTemplate>(templatePath);
    plan = buildPlan(template, await readJson<Json>(dataPath), {
      bindings: await loadBindings(args, template),
    });
  }

  const sourcePath = flag(args, "source") ?? findSourcePdf(plan.source.filename);
  const source = new Uint8Array(await readFile(sourcePath));

  const result = await render(plan, source, { enforceDigest: !has(args, "ignore-digest") });
  await writeOut(outPath, await appendStatements(result.pdf, plan));

  process.stdout.write(`\n${plan.templateId} -> ${outPath}\n`);
  process.stdout.write(`  ${plan.placements.length} placement(s), ${plan.statements.length} statement(s)\n`);
  return report("render", result.diagnostics) === 0 ? 0 : 1;
}

async function cmdImport(args: string[]): Promise<number> {
  const [pdfPath] = positional(args);
  const outPath = flag(args, "out");
  const id = flag(args, "id");
  if (!pdfPath || !outPath || !id) {
    throw new Error("import requires <pdf> --id <template.id> --out <file.json>");
  }

  const bytes = new Uint8Array(await readFile(pdfPath));
  const { template, strategy, skipped } = await importAcroForm(bytes, {
    templateId: id,
    title: flag(args, "title") ?? id,
    taxYear: Number(flag(args, "tax-year") ?? new Date().getUTCFullYear()),
    revision: flag(args, "revision") ?? "unknown",
    filename: pdfPath.split("/").pop() ?? pdfPath,
    url: flag(args, "url"),
  });

  await writeOut(outPath, `${JSON.stringify(template, null, 2)}\n`);
  process.stdout.write(`\n${template.entries.length} field(s) imported -> ${outPath}\n`);
  process.stdout.write(`  strategy: ${strategy}\n`);
  if (strategy === "widgets") {
    process.stdout.write(
      "  the catalog's AcroForm was missing; geometry was recovered from orphaned widget annotations\n",
    );
  }
  for (const note of skipped.slice(0, 10)) process.stdout.write(`  warn  ${note}\n`);
  if (skipped.length > 10) process.stdout.write(`  warn  ...and ${skipped.length - 10} more\n`);
  process.stdout.write("  every value.ref is a TODO and must be bound by hand\n");
  return 0;
}

/**
 * Re-records `source.sha256` after a form has been reissued.
 *
 * Deliberately a separate, explicit step rather than something the renderer
 * does on its own: accepting a new digest means asserting that the
 * coordinates were re-checked. Stamping without looking at the rendered
 * output defeats the guard entirely.
 */
async function cmdStamp(args: string[]): Promise<number> {
  const [templatePath] = positional(args);
  if (!templatePath) throw new Error("stamp requires <template> [--source <file.pdf>]");

  const template = await readJson<AnnotationTemplate>(templatePath);
  const sourcePath = flag(args, "source") ?? findSourcePdf(template.template.source.filename);
  const bytes = new Uint8Array(await readFile(sourcePath));

  const before = template.template.source.sha256;
  const after = sha256(bytes);

  if (before === after) {
    process.stdout.write(`${template.template.id}: digest unchanged (${after})\n`);
    return 0;
  }

  template.template.source.sha256 = after;
  template.template.source.pageCount = template.template.geometry.pages.length;
  await writeOut(templatePath, `${JSON.stringify(template, null, 2)}\n`);

  process.stdout.write(`${template.template.id}: ${before}\n  -> ${after}\n`);
  process.stdout.write("  re-render and check the output before trusting these coordinates\n");
  return 0;
}

/**
 * Draws each field's id inside its own box.
 *
 * A draft imported from a PDF names its fields the way the PDF does — `f1_16[0]`
 * says nothing about which line it is. Printing the ids onto the form itself is
 * the fastest way to bind them: open this next to the blank form and read off
 * which id sits on which line.
 */
async function cmdInspect(args: string[]): Promise<number> {
  const [templatePath] = positional(args);
  const outPath = flag(args, "out");
  if (!templatePath || !outPath) throw new Error("inspect requires <template> --out <file.pdf>");

  const template = await readJson<AnnotationTemplate>(templatePath);

  // Every field becomes a literal label. staticText keeps combs from being
  // split into cells and keeps checkboxes from printing a mark instead.
  const overlay: AnnotationTemplate = {
    ...template,
    defaults: {
      style: { font: "Helvetica", size: 5, color: "#cc0022", align: "left", overflow: "shrink", minSize: 3 },
    },
    bind: undefined,
    entries: template.entries.map((entry) =>
      entry.kind === "field"
        ? { ...entry, type: "staticText", comb: undefined, cents: undefined, visibleWhen: undefined, value: { const: entry.id } }
        : entry,
    ),
  };

  const plan = buildPlan(overlay, {});
  const sourcePath = flag(args, "source") ?? findSourcePdf(template.template.source.filename);
  const source = new Uint8Array(await readFile(sourcePath));

  const result = await render(plan, source, { enforceDigest: false });
  await writeOut(outPath, result.pdf);

  process.stdout.write(`\n${template.template.id}: ${plan.placements.length} field(s) labelled -> ${outPath}\n`);
  return 0;
}

const COMMANDS: Record<string, (args: string[]) => Promise<number>> = {
  fixtures: cmdFixtures,
  lint: cmdLint,
  plan: cmdPlan,
  "check-plan": cmdCheckPlan,
  render: cmdRender,
  import: cmdImport,
  inspect: cmdInspect,
  stamp: cmdStamp,
};

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const run = command ? COMMANDS[command] : undefined;

  if (!run) {
    process.stderr.write(`usage: cli.ts <${Object.keys(COMMANDS).join("|")}> [options]\n`);
    process.exit(2);
  }

  process.exit(await run(args));
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
});

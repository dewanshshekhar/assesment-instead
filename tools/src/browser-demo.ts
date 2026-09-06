#!/usr/bin/env node
/**
 * Builds a self-contained HTML page that fills a form from a render plan.
 *
 * The page is a *second implementation*. It shares no code with anything else
 * in this repository: it reads the plan, applies the placement geometry and
 * policy itself, and draws with the browser's own text layout. That is the
 * claim the specification makes — that a plan is sufficient for someone else
 * to build the printing application with their own code — and this is the
 * cheapest honest way to demonstrate it rather than assert it.
 *
 * Everything is inlined so the result opens with a double-click: no server,
 * no network, no dependencies.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import type { AnnotationTemplate, RenderPlan } from "../../spec/types.ts";
import { buildPlan } from "./plan.ts";
import type { Json } from "./reference.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolvePath(HERE, "../..");
const at = (p: string) => resolvePath(ROOT, p);

const readJson = async <T,>(p: string): Promise<T> => JSON.parse(await readFile(at(p), "utf8")) as T;

async function dataUri(path: string): Promise<string> {
  const bytes = await readFile(at(path));
  return `data:image/png;base64,${bytes.toString("base64")}`;
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const template = await readJson<AnnotationTemplate>("templates/us.irs.f1040sc.2025.json");
const data = await readJson<Json>("examples/sample-return.json");
const plan: RenderPlan = buildPlan(template, data);

const pages = [
  await dataUri("examples/browser/forms/schedule-c-2025-1.png"),
  await dataUri("examples/browser/forms/schedule-c-2025-2.png"),
];

const html = `<!doctype html>
<meta charset="utf-8">
<title>Render plan consumer — ${escapeHtml(plan.templateId)}</title>
<style>
  :root { --ink:#111; --muted:#666; --line:#d8d8d8; --accent:#1a56db; --bad:#c0272d; }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         color:var(--ink); background:#f4f4f5; }
  header { padding:16px 20px; background:#fff; border-bottom:1px solid var(--line); }
  h1 { margin:0 0 4px; font-size:16px; }
  header p { margin:0; color:var(--muted); max-width:70ch; }
  .bar { display:flex; gap:16px; align-items:center; flex-wrap:wrap;
         padding:10px 20px; background:#fff; border-bottom:1px solid var(--line);
         position:sticky; top:0; z-index:5; }
  .bar label { display:flex; gap:6px; align-items:center; cursor:pointer; }
  .stat { margin-left:auto; color:var(--muted); font-variant-numeric:tabular-nums; }
  main { padding:20px; display:flex; justify-content:center; }
  .sheet { position:relative; background:#fff; box-shadow:0 1px 4px rgba(0,0,0,.18); }
  .sheet img { display:block; width:100%; height:auto; }
  .f { position:absolute; display:flex; align-items:center; white-space:pre;
       overflow:hidden; color:#111; }
  .f.right { justify-content:flex-end; }
  .f.center { justify-content:center; }
  .cell { position:absolute; display:flex; align-items:center; justify-content:center; }
  .boxes .f, .boxes .cell { outline:1px solid rgba(26,86,219,.5); background:rgba(26,86,219,.07); }
  .f.overflowed { color:var(--bad); outline:1px solid var(--bad); background:rgba(192,39,45,.1); }
  footer { padding:14px 20px 40px; color:var(--muted); }
  code { background:#eceef1; padding:1px 5px; border-radius:3px; }
</style>

<header>
  <h1>A second implementation, reading the same render plan</h1>
  <p>This page shares no code with the reference renderer. It reads
     <code>${escapeHtml(plan.templateId)}</code>'s render plan and positions every value itself,
     honouring each placement's rectangle, alignment, padding, comb cells and overflow policy.
     Nothing here knows what a template, a reference or a tax form is.</p>
</header>

<div class="bar">
  <label>Page
    <select id="page">
      <option value="0">1 — identity, income, Part II</option>
      <option value="1">2 — Part V and the overflow</option>
    </select>
  </label>
  <label><input type="checkbox" id="boxes"> Show placement boxes</label>
  <span class="stat" id="stat"></span>
</div>

<main><div class="sheet" id="sheet"><img id="page-image" alt=""></div></main>

<footer id="note"></footer>

<script>
// ---------------------------------------------------------------------------
// The plan. This is the entire input: no template, no data set, no library.
// ---------------------------------------------------------------------------
const PLAN = ${JSON.stringify(plan)};
const PAGES = ${JSON.stringify(pages)};

const FONTS = {
  "Helvetica": "Helvetica, Arial, sans-serif",
  "Helvetica-Bold": "Helvetica, Arial, sans-serif",
  "Courier": "'Courier New', Courier, monospace",
  "Courier-Bold": "'Courier New', Courier, monospace",
  "Times-Roman": "'Times New Roman', Times, serif",
};

const sheet = document.getElementById("sheet");
const image = document.getElementById("page-image");
const stat  = document.getElementById("stat");
const note  = document.getElementById("note");

let pageIndex = 0;

/** Measures a string the way this renderer will actually draw it. */
const ruler = document.createElement("canvas").getContext("2d");
function widthOf(text, font, sizePx, bold) {
  ruler.font = (bold ? "bold " : "") + sizePx + "px " + font;
  return ruler.measureText(text).width;
}

function draw() {
  for (const old of sheet.querySelectorAll(".f, .cell")) old.remove();

  const geometry = PLAN.geometry.pages[pageIndex];
  const scale = image.clientWidth / geometry.width;   // px per point
  const placements = PLAN.placements.filter(p => p.page === pageIndex);
  let overflowed = 0;

  for (const p of placements) {
    const [x, y, w, h] = p.rect;
    const font = FONTS[p.font] || FONTS.Helvetica;
    const bold = /Bold/.test(p.font);

    if (p.cells) {
      // Comb: the plan already carries each cell's own x and width, so this
      // renderer must not re-derive them.
      for (const cell of p.cells) {
        if (!cell.char) continue;
        const el = document.createElement("div");
        el.className = "cell";
        el.style.left   = cell.x * scale + "px";
        el.style.top    = y * scale + "px";
        el.style.width  = cell.width * scale + "px";
        el.style.height = h * scale + "px";
        el.style.font   = (bold ? "bold " : "") + (p.size * scale) + "px " + font;
        el.style.color  = p.color;
        el.textContent  = cell.char;
        sheet.appendChild(el);
      }
      continue;
    }

    const inner = {
      x: x + p.padding.left,
      y: y + p.padding.top,
      w: Math.max(0, w - p.padding.left - p.padding.right),
      h: Math.max(0, h - p.padding.top - p.padding.bottom),
    };

    // Overflow policy travels on the placement; applying it is this
    // renderer's job because only it knows its own font metrics.
    let text = p.text;
    let size = p.size * scale;
    const limit = inner.w * scale;
    let broke = false;

    if (widthOf(text, font, size, bold) > limit) {
      if (p.overflow === "shrink") {
        while (size > p.minSize * scale && widthOf(text, font, size, bold) > limit) size -= 0.25;
      } else if (p.overflow === "truncate" || p.overflow === "ellipsis") {
        const tail = p.overflow === "ellipsis" ? "\\u2026" : "";
        while (text.length > 1 && widthOf(text + tail, font, size, bold) > limit) text = text.slice(0, -1);
        text += tail;
      } else {
        broke = true;          // "error": refuse, and say so loudly
        overflowed += 1;
      }
    }

    const el = document.createElement("div");
    el.className = "f " + p.align + (broke ? " overflowed" : "");
    el.style.left   = inner.x * scale + "px";
    el.style.top    = inner.y * scale + "px";
    el.style.width  = inner.w * scale + "px";
    el.style.height = inner.h * scale + "px";
    el.style.font   = (bold ? "bold " : "") + size + "px " + font;
    el.style.color  = broke ? "" : p.color;
    el.title        = p.fieldId;
    el.textContent  = text;
    sheet.appendChild(el);
  }

  stat.textContent = placements.length + " placement(s) on this page" +
    (overflowed ? "  ·  " + overflowed + " refused to fit" : "");

  const statements = PLAN.statements.length;
  note.textContent = statements
    ? "The plan also carries " + statements + " continuation statement(s), holding " +
      PLAN.statements[0].rows.length + " row(s) the form had no room for. Printing those is the " +
      "host application's decision, so this page reports them rather than inventing a layout."
    : "";
}

function show(index) {
  pageIndex = index;
  image.onload = draw;
  image.src = PAGES[index];
}

document.getElementById("page").addEventListener("change", e => show(+e.target.value));
document.getElementById("boxes").addEventListener("change", e =>
  sheet.classList.toggle("boxes", e.target.checked));
addEventListener("resize", draw);

show(0);
</script>
`;

const out = at("out/browser-demo.html");
await mkdir(dirname(out), { recursive: true });
await writeFile(out, html);
process.stdout.write(`${plan.templateId}: ${plan.placements.length} placement(s) -> out/browser-demo.html (${Math.round(html.length / 1024)}KB)\n`);

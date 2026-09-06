#!/usr/bin/env node
/**
 * Builds a self-contained visual annotation editor.
 *
 * Producing a template means deciding where roughly two hundred boxes sit on a
 * page. Importing an AcroForm gets most of them for free, but a form always
 * has boxes the PDF does not declare — Form 1040's "more than four dependents"
 * check is one — and those have to be drawn by hand. Doing that by editing
 * coordinates in JSON and re-rendering to see what moved is the slowest part
 * of the whole exercise.
 *
 * So: the form, the boxes on top of it, drag to move, handles to resize,
 * arrow keys to nudge a point at a time, and the edited template back out as
 * JSON. No server, no network, no dependencies — the page opens with a
 * double-click.
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
  return `data:image/png;base64,${(await readFile(at(path))).toString("base64")}`;
}

const template = await readJson<AnnotationTemplate>("templates/us.irs.f1040sc.2025.json");
const data = await readJson<Json>("examples/sample-return.json");
const plan: RenderPlan = buildPlan(template, data);
const pages = [
  await dataUri("examples/browser/forms/schedule-c-2025-1.png"),
  await dataUri("examples/browser/forms/schedule-c-2025-2.png"),
];

const html = `<!doctype html>
<meta charset="utf-8">
<title>Annotation editor — ${template.template.id}</title>
<style>
  :root { --ink:#111; --muted:#6b7280; --line:#e2e5e9; --sel:#1a56db; --new:#0f766e; --bad:#c0272d; }
  * { box-sizing:border-box; }
  body { margin:0; font:13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         color:var(--ink); background:#f4f4f5; display:grid; grid-template-rows:auto 1fr; height:100vh; }
  header { background:#fff; border-bottom:1px solid var(--line); padding:10px 16px;
           display:flex; gap:14px; align-items:center; flex-wrap:wrap; }
  header h1 { margin:0; font-size:14px; font-weight:600; }
  header .hint { color:var(--muted); }
  .wrap { display:grid; grid-template-columns:1fr 320px; overflow:hidden; }
  .canvas { overflow:auto; padding:20px; }
  .sheet { position:relative; margin:0 auto; background:#fff; box-shadow:0 1px 6px rgba(0,0,0,.2);
           user-select:none; }
  .sheet img { display:block; width:100%; height:auto; pointer-events:none; }
  .box { position:absolute; border:1px solid rgba(26,86,219,.55); background:rgba(26,86,219,.08);
         cursor:move; }
  .box.added { border-color:var(--new); background:rgba(15,118,110,.1); }
  .box.generated { border-style:dashed; border-color:rgba(107,114,128,.55);
                   background:rgba(107,114,128,.07); cursor:default; pointer-events:none; }
  .box.sel { border-color:var(--sel); border-width:2px; background:rgba(26,86,219,.16);
             box-shadow:0 0 0 1px #fff; z-index:3; }
  .box .txt { position:absolute; inset:0; display:flex; align-items:center; overflow:hidden;
              white-space:pre; color:#111; pointer-events:none; }
  .box .txt.right { justify-content:flex-end; } .box .txt.center { justify-content:center; }
  .h { position:absolute; width:7px; height:7px; background:#fff; border:1px solid var(--sel); }
  .h.nw{left:-4px;top:-4px;cursor:nwse-resize} .h.ne{right:-4px;top:-4px;cursor:nesw-resize}
  .h.sw{left:-4px;bottom:-4px;cursor:nesw-resize} .h.se{right:-4px;bottom:-4px;cursor:nwse-resize}
  aside { background:#fff; border-left:1px solid var(--line); overflow:auto; padding:14px 16px; }
  aside h2 { margin:0 0 10px; font-size:12px; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); }
  label { display:block; margin:9px 0 2px; color:var(--muted); font-size:11px; }
  input, select, textarea { width:100%; padding:5px 7px; border:1px solid var(--line); border-radius:4px;
                            font:inherit; font-size:12px; }
  textarea { font-family:ui-monospace, Menlo, monospace; font-size:11px; }
  .row { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
  button { font:inherit; font-size:12px; padding:6px 11px; border:1px solid var(--line);
           background:#fff; border-radius:5px; cursor:pointer; }
  button.primary { background:var(--sel); border-color:var(--sel); color:#fff; }
  button.danger { color:var(--bad); border-color:#f0c8c8; }
  .bar { display:flex; gap:8px; margin-top:14px; flex-wrap:wrap; }
  .empty { color:var(--muted); }
  kbd { background:#eef0f2; border:1px solid var(--line); border-bottom-width:2px; border-radius:3px;
        padding:0 4px; font:inherit; font-size:11px; }
</style>

<header>
  <h1>Annotation editor</h1>
  <label style="margin:0">
    <select id="pageSelect" style="width:auto; display:inline-block">
      <option value="0">Page 1</option><option value="1">Page 2</option>
    </select>
  </label>
  <label style="margin:0">Zoom
    <input id="zoom" type="range" min="60" max="220" value="120" style="width:120px; vertical-align:middle">
  </label>
  <label style="margin:0"><input type="checkbox" id="showText" checked style="width:auto"> Show values</label>
  <span class="hint">drag to move · handles to resize · <kbd>shift</kbd>+drag on the form to draw ·
    <kbd>↑↓←→</kbd> nudge 1pt, with <kbd>shift</kbd> 0.25pt · <kbd>del</kbd> remove ·
    dashed boxes are generated by a repeat</span>
</header>

<div class="wrap">
  <div class="canvas"><div class="sheet" id="sheet"><img id="img" alt=""></div></div>
  <aside id="panel"></aside>
</div>

<script>
const TEMPLATE = ${JSON.stringify(template)};
const PLAN_TEXT = ${JSON.stringify(Object.fromEntries(plan.placements.map((p) => [p.fieldId, p.text])))};
const PAGES = ${JSON.stringify(pages)};

const sheet = document.getElementById("sheet");
const img = document.getElementById("img");
const panel = document.getElementById("panel");
const round2 = n => Math.round(n * 100) / 100;

let page = 0, scale = 1, selected = null, added = new Set();

/** Only flat fields are editable; a repeat's rows are generated from its origin. */
const fields = () => TEMPLATE.entries.filter(e => e.kind === "field" && e.page === page);
const repeats = () => TEMPLATE.entries.filter(e => e.kind === "repeat" && e.page === page);

function geometry() { return TEMPLATE.template.geometry.pages[page]; }

function layout() {
  const zoom = +document.getElementById("zoom").value / 100;
  sheet.style.width = geometry().width * zoom + "px";
  scale = (sheet.clientWidth || geometry().width * zoom) / geometry().width;
}

function draw() {
  layout();
  for (const el of sheet.querySelectorAll(".box")) el.remove();
  const showText = document.getElementById("showText").checked;

  // Generated rows first, underneath, and not interactive: an author needs to
  // see that a region is covered without being able to drag one row out of
  // alignment with the rest.
  for (const g of repeats()) {
    for (let i = 0; i < g.capacity; i += 1) {
      for (const rf of g.item.fields) {
        const el = document.createElement("div");
        el.className = "box generated";
        const gx = g.origin[0] + i * g.step[0] + rf.rect[0];
        const gy = g.origin[1] + i * g.step[1] + rf.rect[1];
        el.style.cssText =
          \`left:\${gx*scale}px;top:\${gy*scale}px;width:\${rf.rect[2]*scale}px;height:\${rf.rect[3]*scale}px\`;
        el.title = \`\${g.id}[\${i}].\${rf.id} — generated from the repeat's origin and step\`;
        sheet.appendChild(el);
      }
    }
  }

  for (const f of fields()) {
    const [x, y, w, h] = f.rect;
    const el = document.createElement("div");
    el.className = "box" + (added.has(f.id) ? " added" : "") + (selected === f.id ? " sel" : "");
    el.style.cssText = \`left:\${x*scale}px;top:\${y*scale}px;width:\${w*scale}px;height:\${h*scale}px\`;
    el.dataset.id = f.id;
    el.title = f.id + (f.label ? "  —  " + f.label : "");

    if (showText && PLAN_TEXT[f.id]) {
      const t = document.createElement("div");
      t.className = "txt " + (f.style?.align || "left");
      t.style.font = ((f.style?.size ?? 8) * scale) + "px " +
        (/Courier/.test(f.style?.font || "") ? "monospace" : "Helvetica, Arial, sans-serif");
      t.textContent = PLAN_TEXT[f.id];
      el.appendChild(t);
    }
    if (selected === f.id) for (const c of ["nw","ne","sw","se"]) {
      const hd = document.createElement("div"); hd.className = "h " + c; hd.dataset.handle = c;
      el.appendChild(hd);
    }
    sheet.appendChild(el);
  }
  renderPanel();
}

// ---------------------------------------------------------------------------
// Property panel
// ---------------------------------------------------------------------------

function field(id) { return TEMPLATE.entries.find(e => e.id === id); }

function renderPanel() {
  const f = selected && field(selected);
  if (!f) {
    panel.innerHTML = '<h2>Nothing selected</h2><p class="empty">Click a box, or hold shift and drag on the form to draw a new one.</p>'
      + '<div class="bar"><button id="export" class="primary">Export template JSON</button></div>';
    document.getElementById("export").onclick = exportJson;
    return;
  }
  const v = f.value || {};
  const bind = v.concept !== undefined
    ? \`<label>Concept</label><input id="p-concept" value="\${v.concept}">\`
    : \`<label>Reference</label><input id="p-ref" value="\${v.ref ?? v.const ?? ""}">\`;

  panel.innerHTML = \`
    <h2>Field</h2>
    <label>Id</label><input id="p-id" value="\${f.id}">
    <label>Label</label><input id="p-label" value="\${f.label ?? ""}">
    <label>Type</label>
    <select id="p-type">\${["text","multilineText","currency","number","percentage","date","comb","checkbox","staticText"]
      .map(t => \`<option\${t===f.type?" selected":""}>\${t}</option>\`).join("")}</select>
    <div class="row"><div><label>x</label><input id="p-x" type="number" step="0.01" value="\${f.rect[0]}"></div>
      <div><label>y</label><input id="p-y" type="number" step="0.01" value="\${f.rect[1]}"></div></div>
    <div class="row"><div><label>width</label><input id="p-w" type="number" step="0.01" value="\${f.rect[2]}"></div>
      <div><label>height</label><input id="p-h" type="number" step="0.01" value="\${f.rect[3]}"></div></div>
    \${f.type === "comb" ? \`<label>Comb cells</label><input id="p-cells" type="number" min="1" value="\${f.comb?.cells ?? 1}">\` : ""}
    <div class="row"><div><label>Align</label>
      <select id="p-align">\${["left","center","right"].map(a => \`<option\${a===(f.style?.align||"left")?" selected":""}>\${a}</option>\`).join("")}</select></div>
      <div><label>Size</label><input id="p-size" type="number" step="0.5" value="\${f.style?.size ?? ""}"></div></div>
    \${bind}
    <div class="bar">
      <button id="p-dup">Duplicate</button>
      <button id="p-del" class="danger">Delete</button>
      <button id="export" class="primary">Export</button>
    </div>\`;

  const num = (el, fn) => el && el.addEventListener("input", () => { fn(parseFloat(el.value)); draw(); });
  num(document.getElementById("p-x"), n => f.rect[0] = n);
  num(document.getElementById("p-y"), n => f.rect[1] = n);
  num(document.getElementById("p-w"), n => f.rect[2] = n);
  num(document.getElementById("p-h"), n => f.rect[3] = n);
  num(document.getElementById("p-cells"), n => { f.comb = { ...(f.comb || {}), cells: n }; });

  document.getElementById("p-id").addEventListener("change", e => {
    const old = f.id; f.id = e.target.value;
    if (added.delete(old)) added.add(f.id);
    selected = f.id; draw();
  });
  document.getElementById("p-label").addEventListener("change", e => f.label = e.target.value);
  document.getElementById("p-type").addEventListener("change", e => { f.type = e.target.value; draw(); });
  document.getElementById("p-align").addEventListener("change", e => {
    f.style = { ...(f.style || {}), align: e.target.value }; draw();
  });
  document.getElementById("p-size").addEventListener("change", e => {
    f.style = { ...(f.style || {}), size: parseFloat(e.target.value) }; draw();
  });
  const c = document.getElementById("p-concept"), r = document.getElementById("p-ref");
  if (c) c.addEventListener("change", e => f.value = { ...f.value, concept: e.target.value });
  if (r) r.addEventListener("change", e => f.value = { ref: e.target.value });

  document.getElementById("p-del").onclick = () => {
    TEMPLATE.entries.splice(TEMPLATE.entries.indexOf(f), 1);
    added.delete(f.id); selected = null; draw();
  };
  document.getElementById("p-dup").onclick = () => {
    const copy = structuredClone(f);
    copy.id = f.id + ".copy"; copy.rect = [f.rect[0], f.rect[1] + f.rect[3] + 2, f.rect[2], f.rect[3]];
    TEMPLATE.entries.splice(TEMPLATE.entries.indexOf(f) + 1, 0, copy);
    added.add(copy.id); selected = copy.id; draw();
  };
  document.getElementById("export").onclick = exportJson;
}

function exportJson() {
  const json = JSON.stringify(TEMPLATE, null, 2);
  navigator.clipboard?.writeText(json).catch(() => {});
  const w = window.open("", "_blank");
  if (w) { w.document.title = "template.json"; w.document.body.style.cssText = "margin:0";
    const pre = w.document.createElement("pre");
    pre.style.cssText = "font:12px ui-monospace,Menlo,monospace;padding:16px;white-space:pre-wrap";
    pre.textContent = json; w.document.body.appendChild(pre); }
}

// ---------------------------------------------------------------------------
// Pointer interaction: move, resize, draw
// ---------------------------------------------------------------------------

let drag = null;
const ptToClient = e => {
  const r = sheet.getBoundingClientRect();
  return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale };
};

sheet.addEventListener("pointerdown", e => {
  const box = e.target.closest(".box");
  const at = ptToClient(e);

  if (!box) {
    if (!e.shiftKey) { selected = null; draw(); return; }
    // Shift-drag on bare form draws a new box.
    const id = "new.field." + (added.size + 1);
    const f = { kind: "field", id, label: "drawn by hand", page, type: "text",
                rect: [round2(at.x), round2(at.y), 1, 1], value: { ref: "@.TODO" },
                style: { align: "left", size: 8 } };
    TEMPLATE.entries.push(f); added.add(id); selected = id;
    drag = { mode: "draw", f, ox: at.x, oy: at.y };
    sheet.setPointerCapture(e.pointerId); draw(); return;
  }

  selected = box.dataset.id;
  const f = field(selected);
  drag = e.target.dataset.handle
    ? { mode: "resize", f, corner: e.target.dataset.handle, start: [...f.rect], ox: at.x, oy: at.y }
    : { mode: "move", f, start: [...f.rect], ox: at.x, oy: at.y };
  sheet.setPointerCapture(e.pointerId);
  draw();
});

sheet.addEventListener("pointermove", e => {
  if (!drag) return;
  const at = ptToClient(e), dx = at.x - drag.ox, dy = at.y - drag.oy, f = drag.f;

  if (drag.mode === "move") {
    f.rect[0] = round2(drag.start[0] + dx);
    f.rect[1] = round2(drag.start[1] + dy);
  } else if (drag.mode === "draw") {
    f.rect = [round2(Math.min(drag.ox, at.x)), round2(Math.min(drag.oy, at.y)),
              round2(Math.max(1, Math.abs(dx))), round2(Math.max(1, Math.abs(dy)))];
  } else {
    const [sx, sy, sw, sh] = drag.start, c = drag.corner;
    let x = sx, y = sy, w = sw, h = sh;
    if (c.includes("w")) { x = sx + dx; w = sw - dx; }
    if (c.includes("n")) { y = sy + dy; h = sh - dy; }
    if (c.includes("e")) w = sw + dx;
    if (c.includes("s")) h = sh + dy;
    f.rect = [round2(x), round2(y), round2(Math.max(1, w)), round2(Math.max(1, h))];
  }
  draw();
});

const endDrag = () => { drag = null; };
sheet.addEventListener("pointerup", endDrag);
sheet.addEventListener("pointercancel", endDrag);

addEventListener("keydown", e => {
  if (!selected || /input|select|textarea/i.test(e.target.tagName)) return;
  const f = field(selected);
  if (e.key === "Delete" || e.key === "Backspace") {
    TEMPLATE.entries.splice(TEMPLATE.entries.indexOf(f), 1);
    added.delete(selected); selected = null; draw(); e.preventDefault(); return;
  }
  const step = e.shiftKey ? 0.25 : 1;
  const move = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
  if (!move) return;
  f.rect[0] = round2(f.rect[0] + move[0]);
  f.rect[1] = round2(f.rect[1] + move[1]);
  draw(); e.preventDefault();
});

document.getElementById("pageSelect").addEventListener("change", e => {
  page = +e.target.value; selected = null; show();
});
document.getElementById("zoom").oninput = draw;
document.getElementById("showText").onchange = draw;

function show() {
  // A data URI may already be decoded, in which case onload never fires.
  img.onload = draw;
  img.src = PAGES[page];
  if (img.complete) draw();
}
show();
</script>
`;

const out = at("out/annotation-editor.html");
await mkdir(dirname(out), { recursive: true });
await writeFile(out, html);
process.stdout.write(
  `${template.template.id}: ${template.entries.filter((e) => e.kind === "field").length} editable field(s)` +
    ` -> out/annotation-editor.html (${Math.round(html.length / 1024)}KB)\n`,
);

/**
 * Reference parsing and resolution.
 *
 * Two syntaxes share one resolver:
 *
 *   JSON Pointer (RFC 6901)   $/income/w2/0/wages     @/wages
 *   JSONPath-lite             $.income.w2[*].wages    @.amount
 *
 * A reference always begins with a scope marker: `$` for the document root,
 * `@` for the node the current binding points at. A leading `/` is accepted
 * as shorthand for `$/`. What follows the marker is a pointer when it starts
 * with `/` or is empty, and JSONPath-lite when it starts with `.` or `[`.
 *
 * The grammar is deliberately total: there is no arithmetic, no function
 * call, no recursive descent and no script expression, so resolution cannot
 * loop, cannot throw on user data, and can be reimplemented in an afternoon
 * in any language.
 */

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export type Segment =
  | { k: "name"; name: string }
  | { k: "index"; index: number }
  | { k: "wildcard" }
  | { k: "filter"; path: string[]; op: "==" | "!="; literal: Json };

export interface ParsedReference {
  scope: "root" | "relative";
  segments: Segment[];
  /** True when the reference can select more than one node. */
  multi: boolean;
}

export class ReferenceSyntaxError extends Error {
  readonly reference: string;

  constructor(reference: string, message: string) {
    super(`invalid reference ${JSON.stringify(reference)}: ${message}`);
    this.name = "ReferenceSyntaxError";
    this.reference = reference;
  }
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export function parseReference(ref: string): ParsedReference {
  if (typeof ref !== "string" || ref.length === 0) {
    throw new ReferenceSyntaxError(String(ref), "must be a non-empty string");
  }

  let scope: "root" | "relative";
  let rest: string;

  if (ref[0] === "$") {
    scope = "root";
    rest = ref.slice(1);
  } else if (ref[0] === "@") {
    scope = "relative";
    rest = ref.slice(1);
  } else if (ref[0] === "/") {
    scope = "root";
    rest = ref;
  } else {
    throw new ReferenceSyntaxError(ref, "must begin with '$', '@' or '/'");
  }

  let segments: Segment[];
  if (rest === "") {
    segments = [];
  } else if (rest[0] === "/") {
    segments = parsePointer(ref, rest);
  } else if (rest[0] === "." || rest[0] === "[") {
    segments = parsePathLite(ref, rest);
  } else {
    throw new ReferenceSyntaxError(ref, `unexpected character ${JSON.stringify(rest[0])} after scope marker`);
  }

  const multi = segments.some((s) => s.k === "wildcard" || s.k === "filter");
  return { scope, segments, multi };
}

/** RFC 6901: split on '/', then unescape '~1' -> '/' and '~0' -> '~'. */
function parsePointer(ref: string, pointer: string): Segment[] {
  return pointer
    .slice(1)
    .split("/")
    .map((raw) => {
      if (/~[^01]/.test(raw) || /~$/.test(raw)) {
        throw new ReferenceSyntaxError(ref, "'~' must be followed by '0' or '1'");
      }
      const name = raw.replace(/~1/g, "/").replace(/~0/g, "~");
      // A pointer token is a name; it is reinterpreted as an array index at
      // resolution time, which is exactly what RFC 6901 prescribes.
      return { k: "name", name } as Segment;
    });
}

function parsePathLite(ref: string, path: string): Segment[] {
  const segments: Segment[] = [];
  let i = 0;

  const fail = (msg: string): never => {
    throw new ReferenceSyntaxError(ref, `${msg} at offset ${i + 1}`);
  };

  while (i < path.length) {
    const c = path[i];

    if (c === ".") {
      i += 1;
      const start = i;
      while (i < path.length && /[A-Za-z0-9_$-]/.test(path[i])) i += 1;
      if (i === start) fail("expected a property name after '.'");
      segments.push({ k: "name", name: path.slice(start, i) });
      continue;
    }

    if (c === "[") {
      const close = path.indexOf("]", i);
      if (close === -1) fail("unterminated '['");
      const inner = path.slice(i + 1, close).trim();

      if (inner === "*") {
        segments.push({ k: "wildcard" });
      } else if (/^-?\d+$/.test(inner)) {
        segments.push({ k: "index", index: Number(inner) });
      } else if (/^'(?:[^'\\]|\\.)*'$/.test(inner)) {
        segments.push({ k: "name", name: unquote(inner) });
      } else if (inner.startsWith("?(") && inner.endsWith(")")) {
        segments.push(parseFilter(ref, inner.slice(2, -1).trim()));
      } else {
        fail(`unsupported bracket expression ${JSON.stringify(inner)}`);
      }

      i = close + 1;
      continue;
    }

    fail(`unexpected character ${JSON.stringify(c)}`);
  }

  return segments;
}

function parseFilter(ref: string, body: string): Segment {
  const m = /^(@(?:\.[A-Za-z0-9_$-]+)+)\s*(==|!=)\s*(.+)$/.exec(body);
  if (!m) {
    throw new ReferenceSyntaxError(
      ref,
      "filter must have the form ?(@.field == literal); only '==' and '!=' are supported",
    );
  }
  const path = m[1].slice(2).split(".");
  return { k: "filter", path, op: m[2] as "==" | "!=", literal: parseLiteral(ref, m[3].trim()) };
}

function parseLiteral(ref: string, raw: string): Json {
  if (/^'(?:[^'\\]|\\.)*'$/.test(raw)) return unquote(raw);
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  throw new ReferenceSyntaxError(ref, `unsupported literal ${JSON.stringify(raw)}`);
}

function unquote(quoted: string): string {
  return quoted.slice(1, -1).replace(/\\(.)/g, "$1");
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export interface ResolutionContext {
  /** The whole data set. */
  root: Json;
  /** The node `@` resolves against. Defaults to `root`. */
  current?: Json;
}

/**
 * Returns every node the reference selects, in document order. A reference
 * that selects nothing returns an empty array; missing data is never an
 * exception, because "the taxpayer has no Schedule C" is ordinary input.
 */
export function resolve(ref: string, ctx: ResolutionContext): Json[] {
  const parsed = parseReference(ref);
  const start = parsed.scope === "root" ? ctx.root : (ctx.current ?? ctx.root);
  return applySegments([start], parsed.segments);
}

export function resolveParsed(parsed: ParsedReference, ctx: ResolutionContext): Json[] {
  const start = parsed.scope === "root" ? ctx.root : (ctx.current ?? ctx.root);
  return applySegments([start], parsed.segments);
}

function applySegments(nodes: Json[], segments: Segment[]): Json[] {
  let current = nodes;
  for (const segment of segments) {
    const next: Json[] = [];
    for (const node of current) step(node, segment, next);
    current = next;
    if (current.length === 0) break;
  }
  return current;
}

function step(node: Json, segment: Segment, out: Json[]): void {
  switch (segment.k) {
    case "name": {
      if (Array.isArray(node)) {
        // RFC 6901 reinterprets a numeric token as an array index.
        if (/^(0|[1-9]\d*)$/.test(segment.name)) {
          const i = Number(segment.name);
          if (i < node.length) out.push(node[i]);
        }
        return;
      }
      if (isObject(node) && Object.prototype.hasOwnProperty.call(node, segment.name)) {
        out.push(node[segment.name]);
      }
      return;
    }

    case "index": {
      if (!Array.isArray(node)) return;
      const i = segment.index < 0 ? node.length + segment.index : segment.index;
      if (i >= 0 && i < node.length) out.push(node[i]);
      return;
    }

    case "wildcard": {
      if (Array.isArray(node)) out.push(...node);
      else if (isObject(node)) out.push(...Object.values(node));
      return;
    }

    case "filter": {
      const candidates = Array.isArray(node) ? node : isObject(node) ? Object.values(node) : [];
      for (const candidate of candidates) {
        const actual = readPath(candidate, segment.path);
        const equal = deepEqual(actual, segment.literal);
        if (segment.op === "==" ? equal : !equal) out.push(candidate);
      }
      return;
    }
  }
}

function readPath(node: Json, path: string[]): Json | undefined {
  let cursor: Json | undefined = node;
  for (const key of path) {
    if (!isObject(cursor)) return undefined;
    if (!Object.prototype.hasOwnProperty.call(cursor, key)) return undefined;
    cursor = cursor[key];
  }
  return cursor;
}

function isObject(v: unknown): v is { [k: string]: Json } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    return (
      ka.length === kb.length &&
      ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
    );
  }
  return false;
}

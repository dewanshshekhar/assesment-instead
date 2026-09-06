/**
 * Formatting: a resolved value becomes the exact string that will be drawn.
 *
 * Money is rounded with scaled-integer arithmetic rather than toFixed, so
 * that binary floating point cannot move a cent.
 */

import type { Json } from "./reference.ts";

export type FieldType =
  | "text"
  | "multilineText"
  | "currency"
  | "number"
  | "percentage"
  | "date"
  | "comb"
  | "checkbox"
  | "staticText";

export interface Format {
  decimals?: number;
  /** half-up rounds halves away from zero, matching IRS whole-dollar practice. */
  rounding?: "half-up" | "half-even" | "truncate";
  thousands?: boolean;
  negative?: "parentheses" | "minus" | "none";
  blankIfZero?: boolean;
  blankIfNull?: boolean;
  prefix?: string;
  suffix?: string;
  dateFormat?: string;
}

const CURRENCY_DEFAULTS: Format = {
  decimals: 0,
  rounding: "half-up",
  thousands: false,
  negative: "parentheses",
  blankIfZero: true,
};

export function formatValue(type: FieldType, value: Json | undefined, format: Format = {}): string {
  if (value === undefined || value === null || value === "") return "";

  switch (type) {
    case "currency":
      return formatNumeric(value, { ...CURRENCY_DEFAULTS, ...format });
    case "number":
      return formatNumeric(value, { decimals: 0, rounding: "half-up", ...format });
    case "percentage":
      // The value is taken to already be in percent units: 12.5 prints as
      // "12.5", never as "1250". Scaling belongs in the calculation engine.
      return formatNumeric(value, { decimals: 2, rounding: "half-up", suffix: "%", ...format });
    case "date":
      return formatDate(value, format);
    default:
      return withAffixes(String(value), format);
  }
}

function formatNumeric(value: Json, format: Format): string {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) return "";

  const decimals = format.decimals ?? 0;
  const rounded = round(n, decimals, format.rounding ?? "half-up");

  if (rounded === 0 && format.blankIfZero) return "";

  const negative = rounded < 0;
  let body = Math.abs(rounded).toFixed(decimals);
  if (format.thousands) body = addThousands(body);

  if (negative) {
    switch (format.negative ?? "minus") {
      case "parentheses":
        return `(${withAffixes(body, format)})`;
      case "none":
        return withAffixes(body, format);
      default:
        return `-${withAffixes(body, format)}`;
    }
  }
  return withAffixes(body, format);
}

/**
 * Rounds on scaled integers. `toPrecision(15)` first collapses the binary
 * representation error that would otherwise make 1.005 round down.
 */
export function round(value: number, decimals: number, mode: "half-up" | "half-even" | "truncate"): number {
  const factor = 10 ** decimals;
  const scaled = Number((value * factor).toPrecision(15));
  const sign = scaled < 0 ? -1 : 1;
  const abs = Math.abs(scaled);
  const floor = Math.floor(abs);
  const fraction = abs - floor;

  let magnitude: number;
  if (mode === "truncate") {
    magnitude = floor;
  } else if (fraction > 0.5) {
    magnitude = floor + 1;
  } else if (fraction < 0.5) {
    magnitude = floor;
  } else if (mode === "half-even") {
    magnitude = floor % 2 === 0 ? floor : floor + 1;
  } else {
    magnitude = floor + 1; // half away from zero
  }

  const result = (sign * magnitude) / factor;
  return result === 0 ? 0 : result; // normalise -0
}

function addThousands(body: string): string {
  const [whole, fraction] = body.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fraction ? `${grouped}.${fraction}` : grouped;
}

function withAffixes(body: string, format: Format): string {
  return `${format.prefix ?? ""}${body}${format.suffix ?? ""}`;
}

/**
 * Accepts an ISO 8601 date (YYYY-MM-DD, optionally with a time part) and
 * rewrites it with the requested tokens. Parsing is done on the string, not
 * via Date, so a local time zone can never shift the day.
 */
function formatDate(value: Json, format: Format): string {
  const iso = String(value);
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return withAffixes(iso, format);

  const [, yyyy, mm, dd] = m;
  const pattern = format.dateFormat ?? "MM/DD/YYYY";
  const body = pattern
    .replace(/YYYY/g, yyyy)
    .replace(/YY/g, yyyy.slice(2))
    .replace(/MM/g, mm)
    .replace(/DD/g, dd);
  return withAffixes(body, format);
}

/**
 * Splits a formatted amount into the dollar and cent columns some forms rule
 * separately. The cents column carries no separator or sign of its own.
 */
export function splitCents(formatted: string): { dollars: string; cents: string } {
  if (formatted === "") return { dollars: "", cents: "" };
  const m = /^(.*?)(\d+)\.(\d{2})(.*)$/.exec(formatted);
  if (!m) return { dollars: formatted, cents: "" };
  return { dollars: `${m[1]}${m[2]}${m[4]}`, cents: m[3] };
}

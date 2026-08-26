// Plain-English labels shared by the engine, the web UI and the CLI. Turning
// customs jargon into words an ordinary importer understands — the rates and
// arithmetic themselves are unchanged and still come from the deterministic
// engine; this only relabels them.

export const LEVY_LABEL: Record<string, string> = {
  duty: "Import Duty",
  vat: "VAT",
  idf: "Import Declaration Fee (IDF)",
  rdl: "Railway Development Levy (RDL)",
  excise: "Excise Duty",
};

/** Friendly name for a levy type, e.g. "idf" -> "Import Declaration Fee (IDF)". */
export function levyLabel(type: string): string {
  return LEVY_LABEL[type] ?? type.toUpperCase();
}

/** What the levy is charged on, in plain words. */
export function basisLabel(basis: string): string {
  return basis === "cif_plus_duty"
    ? "the goods' value plus the duty already added"
    : "the goods' value";
}

/** A rate fraction as a percent string: 0.025 -> "2.5%", 0 -> "0%", null -> "not set". */
export function ratePct(rate: number | null): string {
  if (rate === null) return "not set";
  const pct = rate * 100;
  return `${Number.isInteger(pct) ? pct : pct.toFixed(1)}%`;
}

/** KES money formatting, e.g. 6750 -> "6,750". */
export function money(n: number | null): string {
  return n === null
    ? "—"
    : n.toLocaleString("en-KE", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

/** Shorten a long CET description to something readable in a sentence. */
export function shortDescription(desc: string | null): string {
  if (!desc) return "this item";
  const firstPart = desc.split(/[—–-]/)[0].trim() || desc.trim();
  const s = firstPart.length > 70 ? firstPart.slice(0, 67).trim() + "…" : firstPart;
  return s.charAt(0).toLowerCase() + s.slice(1);
}

// Spreadsheets: Excel (.xlsx) and CSV.
//
// What a cell SHOWS is what gets read, not what it stores. A duty rate kept as
// 0.25 and formatted as a percentage is "25%" to the officer who typed it and
// to every parser downstream; read raw, it is 0.25 — which parseRate would take
// as a quarter of a percent. Formula cells are read by their cached result,
// which is what Excel last displayed; nothing here evaluates a formula.

import { readFile } from "node:fs/promises";

import { clean, tableParts } from "./model";
import type { Part, TableRow } from "./model";

/** Read every worksheet of an .xlsx into parts of up to ROWS_PER_PART rows. */
export async function readXlsx(path: string): Promise<Part[]> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);

  const parts: Part[] = [];
  for (const ws of wb.worksheets) {
    const rows: TableRow[] = [];
    ws.eachRow({ includeEmpty: false }, (row, n) => {
      const cells: string[] = [];
      for (let c = 1; c <= row.cellCount; c++) cells.push(cellText(row.getCell(c)));
      rows.push({ n, cells });
    });
    const sheet = `Sheet "${ws.name}"`;
    parts.push(
      ...tableParts(
        rows,
        (from, to) => (from === to ? `${sheet}, row ${from}` : `${sheet}, rows ${from}–${to}`),
        (n) => `${sheet}, row ${n}`
      )
    );
  }
  return parts;
}

/** Read a CSV into parts. Row numbers are line-of-record numbers, as a spreadsheet shows them. */
export async function readCsv(path: string): Promise<Part[]> {
  const records = parseCsv(decodeText(await readFile(path)));
  const rows: TableRow[] = records.map((cells, i) => ({ n: i + 1, cells: cells.map(clean) }));
  return tableParts(
    rows,
    (from, to) => (from === to ? `row ${from}` : `rows ${from}–${to}`),
    (n) => `row ${n}`
  );
}

// exceljs's own types are loose about cell values; this is the subset it produces.
type CellLike = {
  value: unknown;
  numFmt?: string;
  isMerged: boolean;
  master: { address: string };
  address: string;
};

function cellText(cell: CellLike): string {
  // A merged range reports its value in every cell it covers. Keep it once, in
  // the top-left cell, or a heading merged across five columns reads five times.
  if (cell.isMerged && cell.master.address !== cell.address) return "";
  return clean(formatValue(cell.value, cell.numFmt ?? ""));
}

function formatValue(v: unknown, numFmt: string): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return formatNumber(v, numFmt);
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? "" : v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.richText)) return o.richText.map((r: { text?: string }) => r.text ?? "").join("");
    if ("result" in o || "formula" in o || "sharedFormula" in o) return formatValue(o.result, numFmt);
    if (typeof o.text === "string") return o.text; // hyperlink
    if (typeof o.error === "string") return o.error;
  }
  return String(v);
}

/**
 * A number as the sheet displays it, as far as it matters here.
 *
 * Only the percentage format is applied. Currency symbols, thousands separators
 * and decimal places change nothing a parser reads; a percentage format changes
 * the number itself by a factor of a hundred.
 */
function formatNumber(n: number, numFmt: string): string {
  const fmt = numFmt.replace(/"[^"]*"|\\./g, "");
  if (fmt.includes("%")) return `${tidy(n * 100)}%`;
  return tidy(n);
}

/** Drop binary floating-point noise: 0.1 + 0.2 shows as 0.3, as it does in Excel. */
function tidy(n: number): string {
  return String(Number(n.toPrecision(15)));
}

/**
 * Text of a CSV file.
 *
 * UTF-8 when it is valid UTF-8. Otherwise Windows-1252, which is what Excel on
 * Windows writes when somebody picks plain "CSV" rather than "CSV UTF-8" —
 * reading that as UTF-8 turns every accented name into replacement characters.
 */
export function decodeText(buf: Buffer): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    text = new TextDecoder("windows-1252").decode(buf);
  }
  return text.replace(/^﻿/, "");
}

/**
 * RFC 4180 CSV, with the delimiter detected.
 *
 * Comma, semicolon or tab, whichever appears most often outside quotes on the
 * first line — Excel in a locale that writes decimals as "2,5" separates fields
 * with semicolons, and splitting that on commas cuts every rate in half.
 */
export function parseCsv(text: string): string[][] {
  const delimiter = detectDelimiter(text);
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"' && field === "") {
      quoted = true;
    } else if (ch === delimiter) {
      record.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      record.push(field);
      records.push(record);
      record = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (field !== "" || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records;
}

function detectDelimiter(text: string): string {
  const counts: Record<string, number> = { ",": 0, ";": 0, "\t": 0 };
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === "\n" || ch === "\r")) break;
    else if (!quoted && ch in counts) counts[ch]++;
  }
  let best = ",";
  for (const d of [";", "\t"]) if (counts[d] > counts[best]) best = d;
  return best;
}

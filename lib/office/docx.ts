// Word (.docx) documents.
//
// mammoth converts the document to semantic HTML — headings, paragraphs, list
// items, tables — with no styling, which is exactly the structure needed and
// nothing more. That HTML is then walked by a small reader that knows the
// handful of tags mammoth emits; it is not a general HTML parser and does not
// need to be.
//
// Images are dropped rather than embedded: a scanned page pasted into a Word
// file would otherwise arrive as a multi-megabyte data URI with no text in it.
// External file access stays off — a .docx can name files on the machine that
// opens it, and a document somebody dropped in to try out must not read them.

import { readFile } from "node:fs/promises";

import { clean, proseParts, tableParts } from "./model";
import type { Paragraph, Part, TableRow } from "./model";

/** Read a .docx into parts: prose sections and tables, in document order. */
export async function readDocx(path: string): Promise<Part[]> {
  const mammoth = (await import("mammoth")).default;
  const buffer = await readFile(path);
  const { value: html } = await mammoth.convertToHtml(
    { buffer },
    {
      externalFileAccess: false,
      ignoreEmptyParagraphs: true,
      convertImage: mammoth.images.imgElement(async () => ({ src: "" })),
    }
  );
  return partsFromHtml(html);
}

type Block =
  | { kind: "para"; text: string; heading: boolean }
  | { kind: "table"; rows: string[][] };

const TOKEN = /<(\/?)([a-zA-Z0-9]+)[^>]*?(\/?)>|([^<]+)/g;
const BLOCK_TAGS = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "li"]);

/** Walk mammoth's HTML into paragraphs and tables. */
export function blocksFromHtml(html: string): Block[] {
  const blocks: Block[] = [];
  let text = "";
  let heading = false;
  // Tables nest in Word. Only the outermost is kept as a table; anything inside
  // a cell is read as that cell's text.
  let tableDepth = 0;
  let rows: string[][] = [];
  let row: string[] | null = null;
  let cell: string | null = null;

  const flushPara = () => {
    const t = clean(text);
    if (t) blocks.push({ kind: "para", text: t, heading });
    text = "";
    heading = false;
  };

  for (const m of html.matchAll(TOKEN)) {
    const [, closing, rawTag, , chars] = m;
    if (chars !== undefined) {
      const decoded = decodeEntities(chars);
      if (cell !== null) cell += decoded;
      else text += decoded;
      continue;
    }
    const tag = rawTag.toLowerCase();

    if (tag === "table") {
      if (!closing) {
        if (tableDepth === 0) {
          flushPara();
          rows = [];
        }
        tableDepth++;
      } else {
        tableDepth = Math.max(0, tableDepth - 1);
        if (tableDepth === 0) {
          if (rows.length) blocks.push({ kind: "table", rows });
          rows = [];
          row = null;
          cell = null;
        }
      }
      continue;
    }

    if (tableDepth > 0) {
      if (tableDepth === 1 && tag === "tr") {
        if (!closing) row = [];
        else if (row) {
          rows.push(row);
          row = null;
        }
      } else if (tableDepth === 1 && (tag === "td" || tag === "th")) {
        if (!closing) cell = "";
        else if (row && cell !== null) {
          row.push(clean(cell));
          cell = null;
        }
      } else if (cell !== null && (BLOCK_TAGS.has(tag) || tag === "br" || tag === "tr" || tag === "td")) {
        cell += " ";
      }
      continue;
    }

    if (tag === "br") {
      text += " ";
    } else if (BLOCK_TAGS.has(tag)) {
      // A block opening inside another (a list item holding a paragraph) closes
      // what came before it, so each provision stays its own paragraph.
      flushPara();
      if (!closing) heading = /^h[1-6]$/.test(tag);
    } else if (tag === "ul" || tag === "ol") {
      flushPara();
    }
  }
  flushPara();
  return blocks;
}

/** Turn walked blocks into parts, numbering paragraphs and tables as a reader would. */
export function partsFromHtml(html: string): Part[] {
  const parts: Part[] = [];
  let pending: Paragraph[] = [];
  let paraNo = 0;
  let tableNo = 0;

  const flushProse = () => {
    parts.push(...proseParts(pending));
    pending = [];
  };

  for (const block of blocksFromHtml(html)) {
    if (block.kind === "para") {
      pending.push({ text: block.text, heading: block.heading, n: ++paraNo });
      continue;
    }
    flushProse();
    const t = ++tableNo;
    const rows: TableRow[] = block.rows.map((cells, i) => ({ n: i + 1, cells }));
    parts.push(
      ...tableParts(
        rows,
        (from, to) => (from === to ? `table ${t}, row ${from}` : `table ${t}, rows ${from}–${to}`),
        (n) => `table ${t}, row ${n}`
      )
    );
  }
  flushProse();
  return parts;
}

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (whole, e: string) => {
    const k = e.toLowerCase();
    if (k === "amp") return "&";
    if (k === "lt") return "<";
    if (k === "gt") return ">";
    if (k === "quot") return '"';
    if (k === "apos") return "'";
    if (k === "nbsp") return " ";
    const code = k.startsWith("#x") ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

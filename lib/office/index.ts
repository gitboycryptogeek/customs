// Word and spreadsheet documents, read into the same ExtractedDocument a PDF
// becomes. See ./model.ts for why that shape, and ./render.ts for how a
// citation into one of these files is opened.

import { chunkParagraphs } from "../ingest/chunker";
import { layoutPage } from "../pdf/layout";
import type { ExtractedDocument } from "../pdf/types";
import { readDocx } from "./docx";
import { partToPage, rowText } from "./model";
import type { Part } from "./model";
import { readCsv, readXlsx } from "./sheet";

export type OfficeFormat = "docx" | "xlsx" | "csv";
export type { Part } from "./model";

/** The parts of a file, in order. Part i is cited and linked as page i + 1. */
export async function readParts(path: string, format: OfficeFormat): Promise<Part[]> {
  if (format === "docx") return readDocx(path);
  if (format === "xlsx") return readXlsx(path);
  return readCsv(path);
}

export async function extractOffice(path: string, format: OfficeFormat): Promise<ExtractedDocument> {
  const parts = await readParts(path, format);
  if (parts.length === 0) throw new Error("The file contains no text.");

  const laid = parts.map((part, i) => partToPage(part, i + 1));
  const pages = laid.map((l) => l.page);

  const pageText = parts.map((part, i) =>
    // Prose keeps one line per paragraph — the condition reader works a line at
    // a time, and a sentence cut by synthetic wrapping would never match. Tables
    // get the column grid, which is what every tariff-row pattern expects.
    part.kind === "prose" ? part.paragraphs.map((p) => p.text).join("\n\n") : layoutPage(pages[i])
  );

  const chunks: { text: string; page: number }[] = [];
  parts.forEach((part, i) => {
    const page = i + 1;
    if (part.kind === "prose") {
      chunks.push(...chunkParagraphs(part.paragraphs.map((p) => p.text), page));
    } else {
      for (const row of part.rows) {
        const text = rowText(row, part.header);
        if (text.length >= 3) chunks.push({ text, page });
      }
    }
  });

  return {
    pages,
    pageText,
    method: format,
    meanOcrConfidence: null,
    recoveredWords: 0,
    pageCount: parts.length,
    chunks,
    locate: (page, y) => {
      const part = parts[page - 1];
      if (!part) return `part ${page}`;
      if (part.kind === "table" && y !== undefined) {
        const n = laid[page - 1].rowAtY.get(y);
        if (n !== undefined) return part.rowLabel(n);
      }
      return part.label;
    },
  };
}

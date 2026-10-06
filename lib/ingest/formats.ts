// Which kinds of file can be added, and how each is read.
//
// PDFs go through lib/pdf exactly as before. Word and spreadsheet files go
// through lib/office, which produces the same ExtractedDocument, so everything
// after extraction — classification, chunking, parsing to staging, review — is
// one path for every format.
//
// A file is accepted on its extension AND its first bytes. The extension alone
// would let a renamed executable through to a parser; the bytes alone cannot
// tell a .docx from an .xlsx, since both are zip archives.

import { extname } from "node:path";

import { extractOffice, readParts } from "../office";
import { extractDocument, pageCount } from "../pdf";
import type { ExtractDocumentOptions } from "../pdf";
import type { ExtractedDocument } from "../pdf/types";

export type DocFormat = "pdf" | "docx" | "xlsx" | "csv";

const EXTENSIONS: Record<string, DocFormat> = {
  ".pdf": "pdf",
  ".docx": "docx",
  ".xlsx": "xlsx",
  ".csv": "csv",
};

export const CONTENT_TYPES: Record<DocFormat, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv; charset=utf-8",
};

/** What kind of document a stored file is, from its name. Null for anything else. */
export function formatOf(name: string): DocFormat | null {
  return EXTENSIONS[extname(name).toLowerCase()] ?? null;
}

/** What to tell somebody whose file was refused, naming the fix where there is one. */
export function unsupportedReason(name: string): string {
  const ext = extname(name).toLowerCase();
  if (ext === ".doc") return "Older Word files (.doc) cannot be read. Save it as .docx in Word and add it again.";
  if (ext === ".xls") return "Older Excel files (.xls) cannot be read. Save it as .xlsx in Excel and add it again.";
  return "Not a supported file. PDF, Word (.docx), Excel (.xlsx) and CSV can be read.";
}

/**
 * The format of an upload, checked against its contents. Null when the name
 * and the bytes disagree, or the name is not one we read.
 */
export function detectFormat(name: string, data: Buffer): DocFormat | null {
  const format = formatOf(name);
  if (!format) return null;
  const head = data.subarray(0, 5).toString("latin1");
  if (format === "pdf") return head === "%PDF-" ? format : null;
  if (format === "docx" || format === "xlsx") return head.startsWith("PK\x03\x04") ? format : null;
  // CSV is text. A NUL byte in the first few kilobytes means it is not.
  return data.subarray(0, 8192).includes(0) ? null : format;
}

/** Human name for a format, for error messages. */
export function formatName(format: DocFormat): string {
  return { pdf: "a PDF", docx: "a Word document", xlsx: "an Excel workbook", csv: "a CSV file" }[format];
}

/** Read any supported document. The single entry point the ingest worker uses. */
export async function extractAny(path: string, opts: ExtractDocumentOptions = {}): Promise<ExtractedDocument> {
  const format = formatOf(path);
  if (!format) throw new Error(unsupportedReason(path));
  if (format === "pdf") return extractDocument(path, opts);
  return extractOffice(path, format);
}

/**
 * How many pages — or, for a Word or spreadsheet file, parts — a document has.
 * Opening it is also the check that it is not corrupt.
 */
export async function countPages(path: string): Promise<number> {
  const format = formatOf(path);
  if (!format) throw new Error(unsupportedReason(path));
  if (format === "pdf") return pageCount(path);
  return (await readParts(path, format)).length;
}

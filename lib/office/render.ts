// A Word or spreadsheet file as a page a citation can open.
//
// A browser shows a PDF itself and honours `#page=N`. It shows neither a .docx
// nor an .xlsx — it downloads them, and the citation's page number is lost. So
// these are rendered to HTML from the very same parts the ingest read, with
// each part anchored as `page=N`: every `#page=N` link the app already builds
// lands on the part it cites, with the source row numbers printed beside each
// row so "row 42" can be checked by eye.
//
// The file is untrusted, so every string is escaped and the page is served
// with a CSP that allows no script and no external load.

import type { Part } from "./model";

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function renderPartsHtml(parts: Part[], title: string, downloadHref: string): string {
  const sections = parts
    .map((part, i) => {
      const id = `page=${i + 1}`;
      const head = `<h2><a href="#${esc(id)}">${esc(part.label)}</a></h2>`;
      if (part.kind === "prose") {
        const body = part.paragraphs
          .map((p) => (p.heading ? `<h3>${esc(p.text)}</h3>` : `<p>${esc(p.text)}</p>`))
          .join("\n");
        return `<section id="${esc(id)}">${head}${body}</section>`;
      }
      const cols = Math.max(...[part.header, ...part.rows].filter(Boolean).map((r) => r!.cells.length));
      const cells = (cells: string[], tag: "td" | "th") =>
        Array.from({ length: cols }, (_, c) => `<${tag}>${esc(cells[c] ?? "")}</${tag}>`).join("");
      const thead = part.header
        ? `<thead><tr><th class="n">${part.header.n}</th>${cells(part.header.cells, "th")}</tr></thead>`
        : "";
      const tbody = part.rows.map((r) => `<tr><td class="n">${r.n}</td>${cells(r.cells, "td")}</tr>`).join("\n");
      return `<section id="${esc(id)}">${head}<div class="scroll"><table>${thead}<tbody>${tbody}</tbody></table></div></section>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
:root { --bg: #fff; --fg: #1a1a1a; --muted: #666; --line: #ddd; --hl: #fff6cc; --head: #f4f4f4; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #161616; --fg: #e8e8e8; --muted: #999; --line: #333; --hl: #3a3410; --head: #222; }
}
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.55 system-ui, sans-serif; }
header { position: sticky; top: 0; background: var(--bg); border-bottom: 1px solid var(--line); padding: 10px 16px; display: flex; gap: 16px; align-items: baseline; flex-wrap: wrap; }
header h1 { font-size: 16px; margin: 0; }
header a { color: inherit; }
main { padding: 8px 16px 48px; max-width: 1100px; }
section { padding: 8px 12px; margin: 12px -12px; border-radius: 6px; scroll-margin-top: 56px; }
section:target { background: var(--hl); }
h2 { font-size: 13px; font-weight: 600; color: var(--muted); margin: 8px 0; }
h2 a { color: inherit; text-decoration: none; }
h3 { font-size: 15px; margin: 12px 0 4px; }
p { margin: 6px 0; max-width: 75ch; }
.scroll { overflow-x: auto; }
table { border-collapse: collapse; font-size: 13px; }
th, td { border: 1px solid var(--line); padding: 3px 8px; text-align: left; vertical-align: top; }
th { background: var(--head); }
.n { color: var(--muted); text-align: right; font-variant-numeric: tabular-nums; }
</style>
</head>
<body>
<header><h1>${esc(title)}</h1><a href="${esc(downloadHref)}">Download the original file</a></header>
<main>
${sections || "<p>This file contains no text.</p>"}
</main>
</body>
</html>`;
}

import { chromium } from 'playwright';

// File-submission questions are answered with a document, so the solvers write the
// report body as Markdown and it is turned into a PDF here. Rendering uses the same
// Chromium that Playwright already installs for WebClass, so nothing else is needed.
// The Markdown subset is deliberately small (headings, lists, tables, emphasis);
// the solvers are told to stay inside it.
const PDF_TIMEOUT_MS = 120_000;
const FONTS = '"Yu Gothic", "YuGothic", "Hiragino Kaku Gothic ProN", "Noto Sans JP", "Meiryo", "MS PGothic", sans-serif';

export function reportFiles(number) {
  return { markdown: `report-q${number}.md`, pdf: `report-q${number}.pdf` };
}

export async function renderReportPdf(markdown, pdfPath, { title = '', subtitle = '', author = '' } = {}) {
  const head = [
    title && `<h1 class="doc-title">${escapeHtml(title)}</h1>`,
    (subtitle || author) && `<p class="doc-meta">${[subtitle, author].filter(Boolean).map(escapeHtml).join(' ／ ')}</p>`,
  ].filter(Boolean).join('\n');
  const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><style>
    @page { size: A4; margin: 20mm 18mm; }
    body { font-family: ${FONTS}; font-size: 10.5pt; line-height: 1.8; color: #000; }
    .doc-title { font-size: 15pt; margin: 0 0 4px; }
    .doc-meta { font-size: 9.5pt; color: #333; margin: 0 0 18px; border-bottom: 1px solid #999; padding-bottom: 8px; }
    h1 { font-size: 14pt; margin: 18px 0 8px; }
    h2 { font-size: 12.5pt; margin: 16px 0 6px; }
    h3, h4 { font-size: 11pt; margin: 14px 0 6px; }
    p { margin: 0 0 10px; }
    ul, ol { margin: 0 0 10px; padding-left: 1.6em; }
    li { margin-bottom: 4px; }
    table { border-collapse: collapse; margin: 0 0 12px; }
    th, td { border: 1px solid #666; padding: 4px 8px; font-size: 10pt; }
    th { background: #eee; }
    pre { background: #f4f4f4; padding: 8px 10px; white-space: pre-wrap; font-size: 9.5pt; }
    code { font-family: Consolas, "Courier New", monospace; }
    hr { border: none; border-top: 1px solid #999; margin: 14px 0; }
    h1, h2, h3, h4, table, pre { break-inside: avoid; }
  </style></head><body>${head}${markdownToHtml(markdown)}</body></html>`;

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(PDF_TIMEOUT_MS);
    await page.setContent(html, { waitUntil: 'load' });
    await page.pdf({ path: pdfPath, format: 'A4', printBackground: true });
  } finally {
    await browser.close();
  }
  return pdfPath;
}

export function markdownToHtml(markdown) {
  const lines = String(markdown ?? '').replace(/\r\n/g, '\n').split('\n');
  const html = [];
  let paragraph = [];
  let list = null;
  let table = null;
  let code = null;

  const flushParagraph = () => {
    if (paragraph.length) html.push(`<p>${paragraph.map(inline).join('<br>')}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (list) html.push(`</${list}>`);
    list = null;
  };
  const flushTable = () => {
    if (!table) return;
    const [head, ...body] = table;
    html.push('<table><thead><tr>', ...head.map((cell) => `<th>${inline(cell)}</th>`), '</tr></thead>');
    if (body.length) {
      html.push('<tbody>', ...body.map((row) => `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join('')}</tr>`), '</tbody>');
    }
    html.push('</table>');
    table = null;
  };
  const flush = () => { flushParagraph(); flushList(); flushTable(); };

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      if (code) { html.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`); code = null; }
      else { flush(); code = []; }
      continue;
    }
    if (code) { code.push(line); continue; }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    const row = line.match(/^\s*\|(.*)\|\s*$/);

    if (!line.trim()) {
      flush();
    } else if (heading) {
      flush();
      const level = Math.min(heading[1].length + 1, 4);
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
    } else if (/^\s*([-*_]\s*){3,}$/.test(line)) {
      flush();
      html.push('<hr>');
    } else if (row) {
      flushParagraph();
      flushList();
      const cells = row[1].split('|').map((cell) => cell.trim());
      if (!cells.every((cell) => /^:?-{1,}:?$/.test(cell))) (table ??= []).push(cells);
    } else if (bullet || numbered) {
      flushParagraph();
      flushTable();
      const wanted = bullet ? 'ul' : 'ol';
      if (list !== wanted) { flushList(); html.push(`<${wanted}>`); list = wanted; }
      html.push(`<li>${inline((bullet ?? numbered)[1])}</li>`);
    } else {
      flushList();
      flushTable();
      paragraph.push(line.replace(/^\s*>\s?/, '').trim());
    }
  }
  if (code) html.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
  flush();
  return html.join('\n');
}

function inline(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
}

function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[character]);
}

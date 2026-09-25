import AdmZip from 'adm-zip';
import * as cheerio from 'cheerio';
import { extname } from 'node:path';

const MAX_EXTRACTED_CHARS = 180_000;

export async function extractAttachmentText(name, bytes) {
  const extension = extname(name).toLowerCase();
  let text;
  if (['.txt', '.csv', '.md'].includes(extension)) {
    text = new TextDecoder('utf-8').decode(bytes);
  } else if (['.html', '.htm'].includes(extension)) {
    text = cheerio.load(new TextDecoder('utf-8').decode(bytes))('body').text();
  } else if (extension === '.pdf') {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const pdf = await getDocument({ data: new Uint8Array(bytes), useSystemFonts: true, verbosity: 0 }).promise;
    const pages = [];
    for (let pageNumber = 1; pageNumber <= Math.min(pdf.numPages, 150); pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(`[PDF page ${pageNumber}]\n${content.items.map((item) => item.str ?? '').join(' ')}`);
    }
    text = pages.join('\n\n');
  } else if (extension === '.docx' || extension === '.pptx') {
    const archive = new AdmZip(Buffer.from(bytes));
    const entries = archive.getEntries()
      .filter((entry) => extension === '.docx'
        ? entry.entryName === 'word/document.xml'
        : /^ppt\/slides\/slide\d+\.xml$/.test(entry.entryName))
      .sort((left, right) => left.entryName.localeCompare(right.entryName, undefined, { numeric: true }));
    text = entries.map((entry) => {
      const xml = entry.getData().toString('utf8')
        .replace(/<\/w:p>|<\/a:p>/g, '\n')
        .replace(/<w:tab\b[^>]*\/>/g, '\t');
      return `[${entry.entryName}]\n${cheerio.load(xml, { xmlMode: true }).text()}`;
    }).join('\n\n');
  } else {
    return { text: '', supported: false };
  }
  // NFKC turns PDF compatibility glyphs such as "⼯" into ordinary characters.
  return { text: text.normalize('NFKC').replace(/\r\n/g, '\n').slice(0, MAX_EXTRACTED_CHARS), supported: true };
}

import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';

// Slides often carry their data in charts, figures and tables that never reach the
// extracted text, so every PDF page is also saved as an image the solvers can look at.
// Rendering happens inside Chromium (already used for WebClass): pdf.js drawing to a
// real browser canvas handles the image-heavy pages that Node canvas libraries crash on.
const MAX_PAGES = 80;
const TARGET_WIDTH = 1500;
const RENDER_TIMEOUT_MS = 120_000; // applied per page via the page's default timeout
const ORIGIN = 'https://pdf-render.local';

const require = createRequire(import.meta.url);

export function pageName(pageNumber) {
  return `p${String(pageNumber).padStart(3, '0')}.png`;
}

export async function renderPdfPages(pdfPath, outDir, { maxPages = MAX_PAGES, width = TARGET_WIDTH } = {}) {
  await mkdir(outDir, { recursive: true });
  const files = {
    '/pdf.mjs': [require.resolve('pdfjs-dist/build/pdf.mjs'), 'text/javascript'],
    '/pdf.worker.mjs': [require.resolve('pdfjs-dist/build/pdf.worker.mjs'), 'text/javascript'],
    '/document.pdf': [pdfPath, 'application/pdf'],
  };

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(RENDER_TIMEOUT_MS);
    await page.route(`${ORIGIN}/**`, async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/') {
        await route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><body></body>' });
        return;
      }
      const entry = files[path];
      if (!entry) {
        await route.fulfill({ status: 404, body: '' });
        return;
      }
      await route.fulfill({ contentType: entry[1], body: await readFile(entry[0]) });
    });
    await page.goto(`${ORIGIN}/`);

    const totalPages = await page.evaluate(async (origin) => {
      const pdfjs = await import(`${origin}/pdf.mjs`);
      pdfjs.GlobalWorkerOptions.workerSrc = `${origin}/pdf.worker.mjs`;
      window.pdfDocument = await pdfjs.getDocument({ url: `${origin}/document.pdf`, useSystemFonts: true }).promise;
      return window.pdfDocument.numPages;
    }, ORIGIN);

    const rendered = [];
    const failed = [];
    for (let pageNumber = 1; pageNumber <= Math.min(totalPages, maxPages); pageNumber++) {
      try {
        const dataUrl = await page.evaluate(async ({ pageNumber: number, width: targetWidth }) => {
          const pdfPage = await window.pdfDocument.getPage(number);
          const base = pdfPage.getViewport({ scale: 1 });
          const viewport = pdfPage.getViewport({ scale: Math.min(targetWidth / base.width, 3) });
          const canvas = document.createElement('canvas');
          canvas.width = Math.ceil(viewport.width);
          canvas.height = Math.ceil(viewport.height);
          const context = canvas.getContext('2d');
          context.fillStyle = '#ffffff';
          context.fillRect(0, 0, canvas.width, canvas.height);
          await pdfPage.render({ canvasContext: context, viewport }).promise;
          const url = canvas.toDataURL('image/png');
          pdfPage.cleanup();
          return url;
        }, { pageNumber, width });
        await writeFile(join(outDir, pageName(pageNumber)), Buffer.from(dataUrl.split(',')[1], 'base64'));
        rendered.push(pageNumber);
      } catch (error) {
        if (failed.length === 0) console.warn(`PDFのページ描画に失敗: ${error.message.split('\n')[0]}`);
        failed.push(pageNumber);
      }
    }
    return { rendered, failed, totalPages };
  } finally {
    await browser.close();
  }
}

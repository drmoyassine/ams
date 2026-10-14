// Exporting the org chart (TASK-072): the chart on screen is an SVG with inline presentation attributes only (no classes, no
// CSS variables), so serialising it gives a standalone image that looks the same anywhere. PNG is that SVG drawn onto a canvas at
// 2x in the browser; nothing is sent to a server. Arabic text and right-to-left charts are exported as drawn: the text carries
// its own direction, and the page's fonts (if it loads any as @font-face) are embedded so the image does not depend on them.

const SVG_NS = 'http://www.w3.org/2000/svg';

/** The largest canvas side and area a browser will draw reliably; a bigger chart is exported at a smaller scale. */
export const MAX_CANVAS_SIDE = 16000;
export const MAX_CANVAS_AREA = 100_000_000;

/** The scale for the PNG: 2x, less for a chart so big that 2x would not fit in a canvas. */
export function pngScale(width: number, height: number, wanted = 2): number {
  if (width <= 0 || height <= 0) return wanted;
  return Math.max(0.05, Math.min(wanted, MAX_CANVAS_SIDE / width, MAX_CANVAS_SIDE / height, Math.sqrt(MAX_CANVAS_AREA / (width * height))));
}

export interface SvgOptions {
  /** @font-face CSS to inline (see `pageFontCss`). */
  fontCss?: string;
  title?: string;
  background?: string;
}

/**
 * A standalone SVG document string from the chart's live <svg>: the viewBox is the whole chart (the zoom and pan transform is
 * dropped), nodes marked `data-export-skip` (collapse buttons, focus rings) are left out, and a background is painted.
 */
export function serializeChartSvg(svg: SVGSVGElement, size: { width: number; height: number }, opts: SvgOptions = {}): string {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.querySelectorAll('[data-export-skip]').forEach((n) => n.remove());
  clone.querySelectorAll('[data-view]').forEach((g) => g.removeAttribute('transform'));
  clone.setAttribute('xmlns', SVG_NS);
  clone.setAttribute('viewBox', `0 0 ${size.width} ${size.height}`);
  clone.setAttribute('width', String(size.width));
  clone.setAttribute('height', String(size.height));
  clone.removeAttribute('class');
  clone.removeAttribute('style');
  clone.removeAttribute('tabindex');
  const doc = clone.ownerDocument;
  const bg = doc.createElementNS(SVG_NS, 'rect');
  bg.setAttribute('width', String(size.width));
  bg.setAttribute('height', String(size.height));
  bg.setAttribute('fill', opts.background ?? '#ffffff');
  clone.insertBefore(bg, clone.firstChild);
  if (opts.fontCss) {
    const style = doc.createElementNS(SVG_NS, 'style');
    style.textContent = opts.fontCss;
    clone.insertBefore(style, clone.firstChild);
  }
  if (opts.title) {
    const t = doc.createElementNS(SVG_NS, 'title');
    t.textContent = opts.title;
    clone.insertBefore(t, clone.firstChild);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(clone)}`;
}

/** Draws an SVG string onto a canvas and returns it as a PNG. Needs a browser (Image and canvas). */
export async function svgToPng(svg: string, size: { width: number; height: number }, scale = pngScale(size.width, size.height)): Promise<Blob> {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('The chart could not be drawn as an image.'));
      img.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(size.width * scale));
    canvas.height = Math.max(1, Math.round(size.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('This browser cannot draw the chart as an image.');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('The image could not be made.'))), 'image/png'));
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Saves a blob as a file the person downloads. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * The page's own web fonts as @font-face CSS with the files inlined (data URIs), for the families the page uses, so the
 * exported image does not depend on the page. The application uses the system font stack today, so this is usually empty;
 * it is here so adding a web font later does not break the export.
 */
export async function pageFontCss(doc: Document = document, fetcher: typeof fetch = fetch): Promise<string> {
  const used = (doc.defaultView?.getComputedStyle(doc.body).fontFamily ?? '').split(',').map((f) => f.trim().replace(/^["']|["']$/g, '').toLowerCase());
  const out: string[] = [];
  for (const sheet of [...doc.styleSheets]) {
    let rules: CSSRuleList;
    try { rules = sheet.cssRules; } catch { continue; }
    for (const rule of [...rules]) {
      if (!(rule instanceof CSSFontFaceRule)) continue;
      const family = rule.style.getPropertyValue('font-family').trim().replace(/^["']|["']$/g, '').toLowerCase();
      if (!used.includes(family)) continue;
      let css = rule.cssText;
      for (const m of css.matchAll(/url\((["']?)([^)"']+)\1\)/g)) {
        const href = m[2]!;
        if (href.startsWith('data:')) continue;
        try {
          const res = await fetcher(new URL(href, sheet.href ?? doc.baseURI).toString());
          const bytes = new Uint8Array(await res.arrayBuffer());
          let bin = '';
          for (const b of bytes) bin += String.fromCharCode(b);
          css = css.replace(m[0], `url(data:${res.headers.get('content-type') ?? 'font/woff2'};base64,${btoa(bin)})`);
        } catch { /* a font that cannot be read is left to the system fallback */ }
      }
      out.push(css);
    }
  }
  return out.join('\n');
}

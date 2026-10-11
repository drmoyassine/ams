// Tiny generated files for the reading tests: a PDF, Office packages and a PNG built in code, so no binary fixtures are
// committed. Office packages are zip files written uncompressed (no library: Node's zlib gives the CRC).
import { crc32, deflateSync } from 'node:zlib';

const enc = new TextEncoder();
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };

/** A tiny valid PDF: one page per entry; null makes a blank page (a scan with no text layer). */
export function pdf(pages: (string | null)[]): Uint8Array {
  const objs: string[] = [];
  const kids = pages.map((_, i) => `${3 + i * 2} 0 R`).join(' ');
  objs.push('<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  pages.forEach((t, i) => {
    const content = t === null ? '' : `BT /F1 12 Tf 72 700 Td (${t}) Tj ET`;
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + i * 2} 0 R /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> >>`,
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  });
  let out = '%PDF-1.4\n'; const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return enc.encode(out);
}

/** A zip archive (stored, not compressed) of text entries. */
export function zip(files: Record<string, string>): Uint8Array {
  const parts: Buffer[] = []; const central: Buffer[] = []; let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const n = Buffer.from(name); const data = Buffer.from(text); const crc = crc32(data);
    const local = Buffer.concat([u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(0), u16(0x21), u32(crc), u32(data.length), u32(data.length), u16(n.length), u16(0), n, data]);
    central.push(Buffer.concat([u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(0x21), u32(crc), u32(data.length), u32(data.length), u16(n.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), n]));
    parts.push(local); offset += local.length;
  }
  const cd = Buffer.concat(central);
  return new Uint8Array(Buffer.concat([...parts, cd, u32(0x06054b50), u16(0), u16(0), u16(central.length), u16(central.length), u32(cd.length), u32(offset), u16(0)]));
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const CT = 'application/vnd.openxmlformats-officedocument';
const rels = (items: [string, string, string][]) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.map(([id, type, target]) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`).join('')}</Relationships>`;
const types = (overrides: [string, string][]) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${overrides.map(([p, t]) => `<Override PartName="${p}" ContentType="${t}"/>`).join('')}</Types>`;
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

export interface DocxBlock { text: string; style?: string; rtl?: boolean }
/** A DOCX with paragraphs and (optionally) one table of rows. A paragraph with `pageBreak` starts a new page. */
export function docx(blocks: (DocxBlock | { table: string[][] } | { pageBreak: true })[]): Uint8Array {
  const body = blocks.map((b) => {
    if ('pageBreak' in b) return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
    if ('table' in b) return `<w:tbl><w:tblPr><w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((s) => `<w:${s} w:val="single" w:sz="4"/>`).join('')}</w:tblBorders></w:tblPr>${b.table.map((r) => `<w:tr>${r.map((c) => `<w:tc><w:p><w:r><w:t>${esc(c)}</w:t></w:r></w:p></w:tc>`).join('')}</w:tr>`).join('')}</w:tbl>`;
    const ppr = (b.style ? `<w:pStyle w:val="${b.style}"/>` : '') + (b.rtl ? '<w:bidi/>' : '');
    return `<w:p>${ppr ? `<w:pPr>${ppr}</w:pPr>` : ''}<w:r>${b.rtl ? '<w:rPr><w:rtl/></w:rPr>' : ''}<w:t xml:space="preserve">${esc(b.text)}</w:t></w:r></w:p>`;
  }).join('');
  return zip({
    '[Content_Types].xml': types([['/word/document.xml', `${CT}.wordprocessingml.document.main+xml`]]),
    '_rels/.rels': rels([['rId1', 'officeDocument', 'word/document.xml']]),
    'word/document.xml': `${HEAD}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
  });
}

/** An XLSX: one worksheet per entry, rows of strings (numbers stay numbers when the value is a number). */
export function xlsx(sheets: { name: string; rows: (string | number)[][] }[]): Uint8Array {
  const col = (i: number) => String.fromCharCode(65 + i);
  const sheetXml = (rows: (string | number)[][]) => `${HEAD}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.map((r, y) => `<row r="${y + 1}">${r.map((v, x) => typeof v === 'number' ? `<c r="${col(x)}${y + 1}"><v>${v}</v></c>` : `<c r="${col(x)}${y + 1}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`).join('')}</row>`).join('')}</sheetData></worksheet>`;
  const files: Record<string, string> = {
    '[Content_Types].xml': types([['/xl/workbook.xml', `${CT}.spreadsheetml.sheet.main+xml`], ...sheets.map((_, i) => [`/xl/worksheets/sheet${i + 1}.xml`, `${CT}.spreadsheetml.worksheet+xml`] as [string, string])]),
    '_rels/.rels': rels([['rId1', 'officeDocument', 'xl/workbook.xml']]),
    'xl/workbook.xml': `${HEAD}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${REL}"><sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': rels(sheets.map((_, i) => [`rId${i + 1}`, 'worksheet', `worksheets/sheet${i + 1}.xml`])),
  };
  sheets.forEach((s, i) => { files[`xl/worksheets/sheet${i + 1}.xml`] = sheetXml(s.rows); });
  return zip(files);
}

/** A PPTX: one slide per entry (title and body lines). */
export function pptx(slides: { title: string; lines?: string[] }[]): Uint8Array {
  const NS = `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${REL}" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"`;
  const box = (id: number, y: number, lines: string[]) => `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="t${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="${y}"/><a:ext cx="8229600" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/>${lines.map((l) => `<a:p><a:r><a:rPr lang="en-US" sz="2400"/><a:t>${esc(l)}</a:t></a:r></a:p>`).join('')}</p:txBody></p:sp>`;
  const slide = (s: { title: string; lines?: string[] }) => `${HEAD}<p:sld ${NS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${s.title ? box(2, 365125, [s.title]) : ''}${s.lines?.length ? box(3, 1600200, s.lines) : ''}</p:spTree></p:cSld></p:sld>`;
  const files: Record<string, string> = {
    '[Content_Types].xml': types([['/ppt/presentation.xml', `${CT}.presentationml.presentation.main+xml`], ['/ppt/slideMasters/slideMaster1.xml', `${CT}.presentationml.slideMaster+xml`], ['/ppt/slideLayouts/slideLayout1.xml', `${CT}.presentationml.slideLayout+xml`],
      ...slides.map((_, i) => [`/ppt/slides/slide${i + 1}.xml`, `${CT}.presentationml.slide+xml`] as [string, string])]),
    '_rels/.rels': rels([['rId1', 'officeDocument', 'ppt/presentation.xml']]),
    'ppt/presentation.xml': `${HEAD}<p:presentation ${NS}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join('')}</p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': rels([['rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'], ...slides.map((_, i) => [`rId${i + 2}`, 'slide', `slides/slide${i + 1}.xml`] as [string, string, string])]),
    'ppt/slideMasters/slideMaster1.xml': `${HEAD}<p:sldMaster ${NS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>`,
    'ppt/slideMasters/_rels/slideMaster1.xml.rels': rels([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml']]),
    'ppt/slideLayouts/slideLayout1.xml': `${HEAD}<p:sldLayout ${NS} type="blank"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld></p:sldLayout>`,
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels': rels([['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml']]),
  };
  slides.forEach((s, i) => {
    files[`ppt/slides/slide${i + 1}.xml`] = slide(s);
    files[`ppt/slides/_rels/slide${i + 1}.xml.rels`] = rels([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml']]);
  });
  return zip(files);
}

/** A PNG of a black rectangle on white and no text: a picture of a page, with nothing to read without OCR. */
export function png(width = 200, height = 120): Uint8Array {
  const raw = Buffer.alloc((width * 3 + 1) * height, 0xff);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    if (y > height / 3 && y < height / 2) raw.fill(0, y * (width * 3 + 1) + 1 + 30 * 3, y * (width * 3 + 1) + 1 + 120 * 3);
  }
  const chunk = (type: string, data: Buffer) => { const t = Buffer.from(type); return Buffer.concat([u32be(data.length), t, data, u32be(crc32(Buffer.concat([t, data])))]); };
  const ihdr = Buffer.concat([u32be(width), u32be(height), Buffer.from([8, 2, 0, 0, 0])]);
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}
const u32be = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };

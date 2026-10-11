/** What a source's original can be: everything parseDocument() reads (PDF, Word, Excel, PowerPoint, OpenDocument, RTF, CSV, images). */
export const FILE_ACCEPT = 'application/pdf,.pdf,.docx,.doc,.odt,.rtf,.xlsx,.xls,.ods,.csv,.tsv,text/csv,.pptx,.ppt,.odp,image/png,image/jpeg,image/tiff,image/webp,.png,.jpg,.jpeg,.tif,.tiff,.webp';

const EXTENSIONS = new Set(FILE_ACCEPT.split(',').filter((x) => x.startsWith('.')).map((x) => x.slice(1)));

/** "1.4 MB", "820 KB". */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

const KINDS: Record<string, string> = {
  pdf: 'PDF', doc: 'Word', docx: 'Word', odt: 'OpenDocument', rtf: 'Rich text', xls: 'Excel', xlsx: 'Excel', ods: 'OpenDocument', csv: 'CSV', tsv: 'TSV',
  ppt: 'PowerPoint', pptx: 'PowerPoint', odp: 'OpenDocument', png: 'Image', jpg: 'Image', jpeg: 'Image', tif: 'Image', tiff: 'Image', webp: 'Image',
};
const extensionOf = (name: string) => (name.includes('.') ? name.split('.').pop()!.toLowerCase() : '');

/** A short label for the kind of file, from its name. */
export const fileKind = (name: string) => KINDS[extensionOf(name)] ?? 'File';

/** Is this a kind of file the system can read? (By extension; the server reads the content.) */
export const isReadableKind = (name: string) => EXTENSIONS.has(extensionOf(name));

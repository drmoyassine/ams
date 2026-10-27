import { FILE_ACCEPT } from './source-files';

/**
 * What each place accepts, in one table (DRY): the `accept` of the file picker and the hint shown to the person. The server checks
 * the content again; this only keeps people from choosing something that will be refused.
 */
export type UploadKind = 'document' | 'image' | 'data' | 'any';

export const UPLOAD_RULES: Record<UploadKind, { accept: string | undefined; hint: string }> = {
  document: { accept: FILE_ACCEPT, hint: 'PDF, Word, Excel, PowerPoint, OpenDocument, RTF, CSV or images' },
  image: { accept: 'image/png,image/jpeg,image/webp', hint: 'PNG, JPEG or WebP' },
  data: { accept: '.xlsx,.csv,.tsv,.txt', hint: 'Excel or CSV' },
  any: { accept: undefined, hint: 'Any kind of file' },
};

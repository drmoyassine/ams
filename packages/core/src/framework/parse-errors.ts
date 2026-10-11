// The typed errors of parseDocument(), in their own file so the temporary fallback reader can throw them too.

export type DocumentReadErrorCode = 'unsupported' | 'corrupt' | 'converter_missing' | 'timeout';

/** A file that cannot be read, with a reason a person can act on. Recorded on the document; never retried. */
export class DocumentReadError extends Error {
  readonly status = 400;
  constructor(readonly code: DocumentReadErrorCode, message: string) { super(message); this.name = 'DocumentReadError'; }
}
export class UnsupportedDocumentError extends DocumentReadError {
  constructor(message: string) { super('unsupported', message); this.name = 'UnsupportedDocumentError'; }
}

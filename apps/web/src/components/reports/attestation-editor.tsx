// The attestation editor (TASK-092, PRD 10.3): who signs, the statement, and the signed letter uploaded whole — the
// server stores the file and fills the section's key, name, mime and size in one move, so the letter is always complete.
import { useRef, useState } from 'react';
import type { ReportSection } from '@ams/shared';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { useTranslation } from '../../i18n';

export interface AttestationDraft {
  signatoryName: string | null; signatoryTitle: string | null; statement: string | null;
  fileKey: string | null; fileName: string | null; fileMime: string | null; fileSize: number | null;
}

const of = (content: unknown): AttestationDraft => {
  const c = (content ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof c[k] === 'string' ? c[k] as string : null);
  const num = (k: string) => (typeof c[k] === 'number' ? c[k] as number : null);
  return {
    signatoryName: str('signatoryName'), signatoryTitle: str('signatoryTitle'), statement: str('statement'),
    fileKey: str('fileKey'), fileName: str('fileName'), fileMime: str('fileMime'), fileSize: num('fileSize'),
  };
};

export function AttestationEditor({ section, canWrite, busy, error, onSave, onUpload, letterUrl }: {
  section: ReportSection; canWrite: boolean; busy: boolean; error?: string | null;
  onSave: (content: Partial<AttestationDraft>) => Promise<void>;
  /** Uploads the signed letter; the server stores it and sets the file fields whole. */
  onUpload: (file: File) => Promise<void>;
  /** Where the stored letter is served from, once there is one. */
  letterUrl: string | null;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<AttestationDraft>(() => of(section.content));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const set = (p: Partial<AttestationDraft>) => { setDraft((d) => ({ ...d, ...p })); setDirty(true); };
  const stored = of(section.content);
  const writeable = canWrite && (section.status === 'draft' || section.status === 'returned');

  const save = async () => {
    setSaving(true);
    try {
      const trim = (v: string | null) => { const s = v?.trim() ?? ''; return s ? s : null; };
      await onSave({
        signatoryName: trim(draft.signatoryName), signatoryTitle: trim(draft.signatoryTitle), statement: trim(draft.statement),
        fileKey: stored.fileKey, fileName: stored.fileName, fileMime: stored.fileMime, fileSize: stored.fileSize,
      });
      setDirty(false);
    } finally { setSaving(false); }
  };

  const upload = async (f: File) => {
    setUploading(true);
    try { await onUpload(f); } finally { setUploading(false); }
  };

  const mb = (n: number | null) => (n === null ? '' : ` · ${(n / 1048576).toFixed(2)} MB`);

  return (
    <div className="space-y-2" data-testid="attestation-editor">
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{t('rep.signatoryName')}</span>
          <Input value={draft.signatoryName ?? ''} dir="auto" disabled={!writeable || busy} aria-label={t('rep.signatoryName')}
            onChange={(e) => set({ signatoryName: e.target.value })} data-testid="signatory-name" />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{t('rep.signatoryTitle')}</span>
          <Input value={draft.signatoryTitle ?? ''} dir="auto" disabled={!writeable || busy} aria-label={t('rep.signatoryTitle')}
            onChange={(e) => set({ signatoryTitle: e.target.value })} data-testid="signatory-title" />
        </label>
      </div>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{t('rep.statement')}</span>
        <textarea value={draft.statement ?? ''} dir="auto" rows={3} disabled={!writeable || busy} aria-label={t('rep.statement')}
          className="rounded-md border border-border bg-background p-2 text-sm" onChange={(e) => set({ statement: e.target.value })} data-testid="statement" />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        {stored.fileKey && letterUrl
          ? <a className="text-sm underline" href={letterUrl} target="_blank" rel="noreferrer" data-testid="stored-letter">{stored.fileName}{mb(stored.fileSize)}</a>
          : <span className="text-sm text-muted-foreground" data-testid="no-letter">{t('rep.noLetter')}</span>}
        {writeable && (
          <>
            <Button type="button" variant="outline" disabled={uploading || busy} onClick={() => file.current?.click()} data-testid="upload-letter">
              {uploading ? t('rep.uploading') : t('rep.uploadLetter')}
            </Button>
            <input ref={file} type="file" className="hidden" aria-label={t('rep.uploadLetter')}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ''; }} />
          </>
        )}
        {writeable && (
          <Button type="button" disabled={!dirty || saving || busy} onClick={() => void save()} data-testid="save-attestation">{saving ? t('common.saving') : t('common.save')}</Button>
        )}
        {error && <span role="alert" className="text-xs text-red-700">{error}</span>}
      </div>
    </div>
  );
}

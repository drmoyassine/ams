// The narrative editor (TASK-092, PRD 10.3): Tiptap over paragraphs, stored as { doc, text } — the plain text is what
// the database counts words in and what the diff (TASK-094) and the export read. Arabic keeps dir="auto". Evidence is
// cited inline as [E:<evidenceVersionId>]; the renderer (TASK-093) numbers the tokens by first appearance and prints
// [E-1], [E-2], … — the token stays stable while evidence is added and removed. The evidence panel is a sheet: the
// report stays full width.
import { useEffect, useMemo, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { countWords, type ReportSection } from '@ams/shared';
import { Button } from '../ui/button';
import { EvidenceSheet, type CitableEvidence } from './evidence-sheet';
import type { EvidenceApi } from '../../lib/evidence-api';
import { useTranslation } from '../../i18n';

/** The plain text back into Tiptap paragraphs: a blank line starts a paragraph, a single newline a break inside it. */
export function textToDoc(text: string) {
  const paragraphs = text.split(/\n{2,}/);
  if (!paragraphs.some((p) => p.trim())) return { type: 'doc', content: [] };
  return {
    type: 'doc',
    content: paragraphs.map((p) => ({
      type: 'paragraph',
      content: p.split('\n').flatMap((line, i) => {
        const run = line ? [{ type: 'text', text: line }] : [];
        return i === 0 ? run : [{ type: 'hardBreak' }, ...run];
      }),
    })),
  };
}

export function NarrativeEditor({ section, canWrite, busy, onSave, error, evidence }: {
  section: ReportSection; canWrite: boolean; busy: boolean; error?: string | null;
  onSave: (content: { doc: unknown; text: string }) => Promise<void>;
  /** Injectable evidence client (tests); the default talks to the app. */
  evidence?: EvidenceApi;
}) {
  const { t } = useTranslation();
  const saved = useMemo(() => (section.content ?? {}) as { doc?: unknown; text?: string }, [section.content]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sheet, setSheet] = useState(false);
  const editor = useEditor({
    extensions: [StarterKit.configure({ heading: false })],
    content: textToDoc(saved.text ?? ''),
    editable: canWrite,
    onUpdate: () => setDirty(true),
  });
  // A save elsewhere (or a fresh detail after the owner changed) refreshes the text while the person is not typing.
  useEffect(() => {
    if (dirty || !editor) return;
    editor.commands.setContent(textToDoc(saved.text ?? ''), { emitUpdate: false });
  }, [saved.text, dirty, editor]);

  const writeable = canWrite && (section.status === 'draft' || section.status === 'returned');
  const live = editor?.getText({ blockSeparator: '\n\n' }) ?? '';
  const words = countWords(live);
  const over = section.wordLimit !== null && words > section.wordLimit;

  const save = async () => {
    if (!editor) return;
    setSaving(true);
    try {
      await onSave({ doc: editor.getJSON(), text: editor.getText({ blockSeparator: '\n\n' }) });
      setDirty(false);
    } finally { setSaving(false); }
  };

  const cite = (e: CitableEvidence) => {
    editor?.chain().focus().insertContent(`[E:${e.versionId}]`).run();
    setSheet(false);
  };

  return (
    <div className="space-y-2" data-testid="narrative-editor">
      {section.prompt && <p className="rounded-md bg-muted p-2 text-sm text-muted-foreground" dir="auto" data-testid="section-prompt">{section.prompt}</p>}
      {writeable && (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" onClick={() => setSheet(true)} data-testid="open-evidence">{t('rep.citeEvidence')}</Button>
          <span className="text-xs text-muted-foreground" data-testid="citation-hint">{t('rep.citationHint')}</span>
        </div>
      )}
      <div dir="auto" className="min-h-32 rounded-md border border-border p-2" data-testid="narrative-surface">
        <EditorContent editor={editor} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className={`text-xs ${over ? 'font-medium text-red-700' : 'text-muted-foreground'}`} data-testid="word-count">
          {t('rep.words', { count: words })}{section.wordLimit !== null ? ` / ${section.wordLimit}` : ''}
        </span>
        {over && <span role="note" className="text-xs text-red-700" data-testid="word-warning">{t('rep.overLimit')}</span>}
        {canWrite && (
          <Button type="button" disabled={!dirty || saving || busy || !writeable} onClick={() => void save()} data-testid="save-narrative">
            {saving ? t('common.saving') : t('common.save')}
          </Button>
        )}
        {canWrite && !writeable && <span className="text-xs text-muted-foreground">{t('rep.lockedSection')}</span>}
        {error && <span role="alert" className="text-xs text-red-700">{error}</span>}
      </div>
      {sheet && <EvidenceSheet requirements={section.requirements} api={evidence} onCite={cite} onClose={() => setSheet(false)} />}
    </div>
  );
}

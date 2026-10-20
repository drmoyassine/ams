// Two small dialogs of the link review loop (TASK-088): a reviewer says WHY a link is rejected (required), and the person who
// proposed a rejected link answers it with a new reason. Used wherever links are listed and from My work.
import { useState, type FormEvent } from 'react';
import type { EvidenceLink } from '@ams/shared';
import { useTranslation } from '../i18n';
import { formatDate } from '../lib/intl';
import { targetText } from '../lib/link-text';
import { ContentText } from './content-text';
import { Dialog } from './dialog';
import { Button } from './ui/button';

/** "Rejected by X on date: reason", for a rejected link everywhere it is shown. */
export function RejectedLine({ link }: { link: EvidenceLink }) {
  const { t } = useTranslation();
  if (link.reviewStatus !== 'rejected') return null;
  return (
    <p className="text-xs text-red-900" data-testid="link-rejected">
      {t('evidence.rejectedBy', {
        name: link.reviewedByName ?? t('evidence.aReviewer'), date: link.reviewedAt ? formatDate(link.reviewedAt) : '', reason: link.reviewComment ?? '',
      })}
    </p>
  );
}

function ReasonDialog({ titleId, title, subject, label, hint, submitLabel, busyLabel, initial = '', onSubmit, onClose, children }: {
  titleId: string; title: string; subject: string; label: string; hint: string; submitLabel: string; busyLabel: string; initial?: string;
  onSubmit: (text: string) => Promise<unknown>; onClose: () => void; children?: React.ReactNode;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true); setError('');
    try { await onSubmit(text.trim()); onClose(); } catch (err) { setError((err as Error).message); setBusy(false); }
  };
  return (
    <Dialog labelledBy={titleId} onClose={onClose} z="z-[60]">
      <div className="mb-3 flex items-start justify-between gap-2">
        <h2 id={titleId} className="min-w-0 pt-1 text-lg font-semibold break-words sm:text-xl">{title}</h2>
        <Button type="button" variant="ghost" aria-label={t('common.close')} onClick={onClose}>✕</Button>
      </div>
      <form onSubmit={(e) => void submit(e)} className="space-y-3" aria-label={title}>
        <p className="break-words text-sm" dir="auto"><ContentText>{subject}</ContentText></p>
        {children}
        <label className="flex flex-col text-sm">{label}
          <textarea aria-label={label} required rows={3} dir="auto" autoFocus value={text} onChange={(e) => setText(e.target.value)} className="rounded-md border border-border p-2 text-sm" />
        </label>
        <p className="text-xs text-muted-foreground">{hint}</p>
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" disabled={busy || !text.trim()}>{busy ? busyLabel : submitLabel}</Button>
        </div>
      </form>
    </Dialog>
  );
}

/** The Reject action: the reason is required (the proposer is told with it). */
export function RejectLinkDialog({ link, onReject, onClose }: { link: EvidenceLink; onReject: (reason: string) => Promise<unknown>; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <ReasonDialog titleId="reject-link-title" title={t('evidence.reject.title')} subject={`${link.evidenceTitle} → ${targetText(link.target)}`}
      label={t('evidence.reject.why')} hint={t('evidence.reject.hint')} submitLabel={t('evidence.reject.submit')} busyLabel={t('evidence.reject.busy')} onSubmit={onReject} onClose={onClose} />
  );
}

/** The proposer's answer to a rejection: the justification, prefilled, goes back to review with the new text. */
export function ResubmitLinkDialog({ link, onResubmit, onClose }: { link: EvidenceLink; onResubmit: (rationale: string) => Promise<unknown>; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <ReasonDialog titleId="resubmit-link-title" title={t('evidence.resubmit.title')} subject={`${link.evidenceTitle} → ${targetText(link.target)}`}
      label={t('evidence.resubmit.why')} hint={t('evidence.resubmit.hint')} submitLabel={t('evidence.resubmit.submit')} busyLabel={t('evidence.resubmit.busy')}
      initial={link.rationale} onSubmit={onResubmit} onClose={onClose}>
      <RejectedLine link={link} />
    </ReasonDialog>
  );
}

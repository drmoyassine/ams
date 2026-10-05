import { useTranslation } from 'react-i18next';
import { cn } from '../lib/utils';

const AUTHORITY = {
  required: { label: 'Required', hint: 'The accreditor explicitly requires it', cls: 'bg-red-100 text-red-900 border-red-300' },
  example: { label: 'Example', hint: 'The accreditor gives it as an illustration', cls: 'bg-sky-100 text-sky-900 border-sky-300' },
  suggested: { label: 'Suggested', hint: 'The accreditor suggests it', cls: 'bg-amber-100 text-amber-900 border-amber-300' },
  ai_suggested: { label: 'AI-suggested', hint: 'Inferred by the AI; no source sentence requires it', cls: 'bg-purple-100 text-purple-900 border-purple-300' },
  institution_defined: { label: 'Institution-defined', hint: 'Added by the institution', cls: 'bg-emerald-100 text-emerald-900 border-emerald-300' },
} as const;

/** Authority is shown as a coloured badge in every view (PRD 6.3). */
export function AuthorityBadge({ authority }: { authority: keyof typeof AUTHORITY }) {
  const a = AUTHORITY[authority];
  return <span title={a.hint} data-testid="authority" className={cn('rounded border px-2 py-0.5 text-xs font-medium', a.cls)}>{a.label}</span>;
}

const REVIEW = {
  pending: { label: 'Pending review', cls: 'bg-muted text-muted-foreground border-border' },
  approved: { label: 'Reviewed: approved', cls: 'bg-emerald-50 text-emerald-900 border-emerald-300' },
  rejected: { label: 'Reviewed: rejected', cls: 'bg-red-50 text-red-900 border-red-300' },
} as const;

/** Internal review state of framework content. This is never an accreditation status (DEC-005). */
export function ReviewBadge({ status }: { status: keyof typeof REVIEW }) {
  const r = REVIEW[status];
  return <span data-testid="review" className={cn('rounded border px-2 py-0.5 text-xs', r.cls)}>{r.label}</span>;
}

const STATUS = { draft: 'Draft', in_review: 'In review', published: 'Published', retired: 'Retired' } as const;
export function VersionStatusBadge({ status }: { status: keyof typeof STATUS }) {
  const { t } = useTranslation();
  return <span data-testid="version-status" className="rounded bg-primary px-2 py-0.5 text-xs text-primary-foreground">{t(`framework.status.${status}`, STATUS[status])}</span>;
}

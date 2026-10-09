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
  pending: { label: 'Pending review', short: 'Pending', dot: 'bg-muted-foreground', cls: 'bg-muted text-muted-foreground border-border' },
  approved: { label: 'Reviewed: approved', short: 'Approved', dot: 'bg-emerald-600', cls: 'bg-emerald-50 text-emerald-900 border-emerald-300' },
  rejected: { label: 'Reviewed: rejected', short: 'Rejected', dot: 'bg-red-600', cls: 'bg-red-50 text-red-900 border-red-300' },
} as const;

/**
 * Internal review state of framework content. This is never an accreditation status (DEC-005). Below `sm` it shows a
 * coloured dot and one word; the full wording stays in the DOM for screen readers (and is what `data-testid="review"`
 * holds).
 */
export function ReviewBadge({ status }: { status: keyof typeof REVIEW }) {
  const r = REVIEW[status];
  return (
    <span className="inline-flex shrink-0">
      <span aria-hidden="true" title={r.label} className="inline-flex items-center gap-1 whitespace-nowrap text-xs text-muted-foreground sm:hidden">
        <span className={cn('size-2 rounded-full', r.dot)} />{r.short}
      </span>
      <span data-testid="review" className={cn('whitespace-nowrap rounded border px-2 py-0.5 text-xs max-sm:sr-only', r.cls)}>{r.label}</span>
    </span>
  );
}

const STATUS = { draft: 'Draft', in_review: 'In review', published: 'Published', retired: 'Retired' } as const;
export function VersionStatusBadge({ status }: { status: keyof typeof STATUS }) {
  const { t } = useTranslation();
  return <span data-testid="version-status" className="rounded bg-primary px-2 py-0.5 text-xs text-primary-foreground">{t(`framework.status.${status}`, STATUS[status])}</span>;
}

const ORIGIN = {
  template: { label: 'From template', hint: 'Required by the accreditor\'s framework', cls: 'bg-sky-50 text-sky-900 border-sky-300' },
  modified: { label: 'Modified', hint: 'From the template, changed by this engagement', cls: 'bg-amber-50 text-amber-900 border-amber-300' },
  local: { label: 'Added locally', hint: 'Added by the institution', cls: 'bg-emerald-50 text-emerald-900 border-emerald-300' },
  decision: { label: 'From decision', hint: 'Created by an accreditation decision', cls: 'bg-purple-50 text-purple-900 border-purple-300' },
  response: { label: 'From response', hint: 'Created by an accreditor response', cls: 'bg-purple-50 text-purple-900 border-purple-300' },
} as const;

/** Which steps the accreditor requires and which the institution chose (PRD 8.5). */
export function OriginBadge({ origin }: { origin: keyof typeof ORIGIN }) {
  const o = ORIGIN[origin];
  return <span title={o.hint} data-testid="origin" className={cn('rounded border px-2 py-0.5 text-xs', o.cls)}>{o.label}</span>;
}

export const REQUIREMENT_STATUS = {
  not_started: 'Not started',
  in_progress: 'In progress',
  ready_for_review: 'Ready for review',
  approved: 'Internally approved', // never "compliant" or "met" (DEC-005)
  needs_work: 'Needs work',
} as const;
const REQUIREMENT_STATUS_CLS = {
  not_started: 'bg-muted text-muted-foreground border-border',
  in_progress: 'bg-sky-50 text-sky-900 border-sky-300',
  ready_for_review: 'bg-amber-50 text-amber-900 border-amber-300',
  approved: 'bg-emerald-50 text-emerald-900 border-emerald-300',
  needs_work: 'bg-red-50 text-red-900 border-red-300',
} as const;

/** Internal progress only. "Internally approved" is not an accreditation status (DEC-005). */
export function RequirementStatusBadge({ status }: { status: keyof typeof REQUIREMENT_STATUS }) {
  return <span data-testid="requirement-status" className={cn('rounded border px-2 py-0.5 text-xs', REQUIREMENT_STATUS_CLS[status])}>{REQUIREMENT_STATUS[status]}</span>;
}

export const MILESTONE_STATUS = { not_started: 'Not started', in_progress: 'In progress', done: 'Done', skipped: 'Skipped' } as const;

/** Made by the framework analysis (origin 'ai'). Stays after a person edits it: the origin is kept (PRD 16). */
export function AiMarker() {
  return <span title="Made by the AI analysis from the sources" aria-label="Made by AI" data-testid="ai-marker" className="rounded border border-violet-300 bg-violet-50 px-1.5 text-xs text-violet-900">AI</span>;
}

/** The AI's quote was not found on the cited page (or its neighbours): check it against the source. */
export function QuoteNotFoundBadge() {
  return <span role="note" data-testid="quote-not-found" className="rounded border border-amber-300 bg-amber-50 px-1.5 text-xs text-amber-900">Quote not found in source</span>;
}

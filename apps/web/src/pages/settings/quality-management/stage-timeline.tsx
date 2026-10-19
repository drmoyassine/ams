// A read-only preview of a template's stages on a timeline: each stage as a bar from its start day to its end day. Bars are
// percentages of the whole span inside a row of their own, so the preview never scrolls sideways, even on a phone.
import { useTranslation } from '../../../i18n';
import { timeline, type EStage } from './editor-model';

export function StageTimeline({ stages }: { stages: readonly EStage[] }) {
  const { t } = useTranslation();
  const { rows, total } = timeline(stages);
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">{t('qmt.timeline.empty')}</p>;
  return (
    <div data-testid="stage-timeline">
      <p className="mb-2 text-xs text-muted-foreground">{t('qmt.timeline.total', { days: total })}</p>
      <ol aria-label={t('qmt.timeline.label')} className="space-y-2">
        {rows.map((r) => (
          <li key={r.uid} className="grid gap-1 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)] sm:items-center sm:gap-3" data-testid="timeline-row">
            <div className="min-w-0 text-sm">
              <span className="break-words" dir="auto">{r.no}. {r.name || t('qmt.stage.unnamed')}</span>
              <span className="ms-2 text-xs text-muted-foreground">{t('qmt.stage.days', { from: r.start, to: r.end })}</span>
            </div>
            <div className="relative h-3 overflow-hidden rounded bg-muted" aria-hidden="true">
              <div className="absolute top-0 h-3 rounded bg-primary" style={{ insetInlineStart: `${(r.start / total) * 100}%`, width: `${Math.max(1.5, ((r.end - r.start) / total) * 100)}%` }} />
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

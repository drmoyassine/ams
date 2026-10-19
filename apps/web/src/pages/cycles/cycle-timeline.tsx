// The stages of a cycle on a timeline: one row per stage with a bar from its start date to its end date, drawn as percentages of the
// whole span inside a row of its own (so it never scrolls sideways, even on a phone). The bar's colour follows the stage's status; a
// stage without dates has no bar. A stage's name jumps to its card.
import type { CycleDetail } from '@ams/shared';
import { STAGE_TONE, day, stageStatusLabels, type Tone } from '../../components/cycles/labels';
import { useTranslation } from '../../i18n';
import type { T } from '../settings/quality-management/labels';

const BAR: Record<Tone, string> = {
  neutral: 'bg-muted-foreground/50', info: 'bg-primary', good: 'bg-emerald-600', warn: 'bg-amber-500', bad: 'bg-red-600',
};
const ms = (d: string) => Date.parse(`${d}T00:00:00Z`);
const DAY = 86400000;

export function CycleTimeline({ cycle, onOpen }: { cycle: CycleDetail; onOpen: (stageId: string) => void }) {
  const { t: tr } = useTranslation();
  const t = tr as unknown as T;
  const statuses = stageStatusLabels(t);
  const dated = cycle.stages.filter((s) => s.startDate && s.endDate);
  if (cycle.stages.length === 0) return null;
  const from = dated.length ? Math.min(...dated.map((s) => ms(s.startDate!))) : 0;
  const to = dated.length ? Math.max(...dated.map((s) => ms(s.endDate!))) : 0;
  const span = Math.max(DAY, to - from + DAY);
  const todayAt = ms(new Date().toISOString().slice(0, 10));
  const showToday = dated.length > 0 && cycle.status === 'active' && todayAt >= from && todayAt <= to + DAY;
  return (
    <div data-testid="cycle-timeline">
      <ol aria-label={t('qmc.timeline.label')} className="space-y-2">
        {cycle.stages.map((s, i) => (
          <li key={s.id} data-testid="timeline-row" data-status={s.status} className="grid gap-1 sm:grid-cols-[minmax(0,16rem)_minmax(0,1fr)] sm:items-center sm:gap-3">
            <div className="min-w-0 text-sm">
              <button type="button" className="max-w-full break-words text-start underline-offset-2 hover:underline" dir="auto" onClick={() => onOpen(s.id)}>{i + 1}. {s.name}</button>
              <span className="ms-2 text-xs text-muted-foreground">{statuses[s.status]}{s.late ? ` · ${t('qmc.late')}` : ''}</span>
              {s.startDate && s.endDate && <span className="block text-xs text-muted-foreground">{day(s.startDate)} – {day(s.endDate)}</span>}
            </div>
            <div className="relative h-3 overflow-hidden rounded bg-muted" aria-hidden="true">
              {s.startDate && s.endDate && (
                <div className={`absolute top-0 h-3 rounded ${BAR[s.late ? 'bad' : STAGE_TONE[s.status]]}`}
                  style={{ insetInlineStart: `${((ms(s.startDate) - from) / span) * 100}%`, width: `${Math.max(1.5, ((ms(s.endDate) - ms(s.startDate) + DAY) / span) * 100)}%` }} />
              )}
              {showToday && <div className="absolute top-0 h-3 w-px bg-foreground" style={{ insetInlineStart: `${((todayAt - from) / span) * 100}%` }} />}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

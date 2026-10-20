// What a requirement is assigned to and who answers for it, in words, with where each value comes from (TASK-086). Used by the hover
// cards, the dialogs and the lists. Names of units, programs and people are content: shown with dir="auto". Nothing here says
// "compliant" or "met": a scope is where a standard applies, a champion is who answers for it.
import type { TFunction } from 'i18next';
import type { AssignmentSource, EffectiveChampion, EffectiveScope, NodeAssignment } from '@ams/shared';
import { useTranslation } from '../../i18n';
import { ContentText } from '../content-text';
import { planSourceLabel, recurrenceText } from '../plans/labels';

/** "Own", "From Standard 4", "From IQF 4.2" (several mapped IQF items: "From IQF 4.1, 4.2"). `internal`: the requirement is in the institution's own framework. */
export function sourceLabel(sources: AssignmentSource[], internal: boolean, t: TFunction): string {
  if (sources.some((s) => s.kind === 'own')) return t('ops.source.own');
  const iqf = sources.filter((s) => s.kind === 'iqf').map((s) => s.code);
  if (iqf.length) return t('ops.source.iqf', { codes: iqf.join(', ') });
  const parent = sources.find((s) => s.kind === 'parent');
  if (parent) return t(internal ? 'ops.source.standard' : 'ops.source.parent', { code: parent.code });
  return '';
}

/** The names of what a scope covers, per level: "Program: BS Civil, BS Nursing", "Unit: all". */
export function ScopeText({ scope }: { scope: EffectiveScope }) {
  const { t } = useTranslation();
  return (
    <>
      {scope.levels.map((l, i) => (
        <span key={l.levelKey}>
          {i > 0 && '; '}
          <ContentText>{l.labelEn}</ContentText>: {l.all ? t('ops.scope.all') : l.items.length === 0 ? t('ops.scope.noneLeft') : l.items.map((it, j) => <span key={it.id}>{j > 0 && ', '}<ContentText>{it.nameEn}</ContentText></span>)}
        </span>
      ))}
    </>
  );
}

/** One champion entry: "Ann Hassan (From Standard 4)", or the ask for one. */
export function ChampionText({ c, internal }: { c: EffectiveChampion; internal: boolean }) {
  const { t } = useTranslation();
  if (c.needsOne) return <span className="text-amber-900">{t('ops.champion.needsOne')}</span>;
  return <><ContentText>{c.userName ?? '?'}</ContentText> <span className="text-muted-foreground">({sourceLabel(c.sources, internal, t)})</span></>;
}

/**
 * Scope and champion of one requirement as two short lines for a hover card. `assignment` is one entry of the version's batched
 * requirement-context; without it (still loading, or no permission) nothing is shown.
 */
export function AssignmentLines({ assignment, internal }: { assignment: NodeAssignment | undefined; internal: boolean }) {
  const { t } = useTranslation();
  if (!assignment) return null;
  const scope = assignment.scope.effective;
  const overall = assignment.champion.effective.find((c) => c.itemKind === null);
  const items = assignment.champion.effective.filter((c) => c.itemKind !== null);
  return (
    <div data-testid="assignment-lines">
      <p className="mt-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('ops.scope.label')}</p>
      {scope
        ? <p className="text-xs" data-testid="hover-scope"><ScopeText scope={scope} /> <span className="text-muted-foreground">({sourceLabel(scope.sources, internal, t)})</span></p>
        : <p className="text-xs text-muted-foreground" data-testid="hover-scope">{t('ops.scope.none')}</p>}
      <p className="mt-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('ops.champion.label')}</p>
      {!overall && items.length === 0 ? <p className="text-xs text-muted-foreground" data-testid="hover-champion">{t('ops.champion.none')}</p> : (
        <ul className="list-none space-y-0.5 text-xs" data-testid="hover-champion">
          {overall && <li><ChampionText c={overall} internal={internal} /></li>}
          {items.map((c) => <li key={`${c.itemKind}:${c.itemId}`}><ContentText>{c.itemName}</ContentText>: <ChampionText c={c} internal={internal} /></li>)}
        </ul>
      )}
      <PlanLines plans={assignment.plans} internal={internal} />
    </div>
  );
}

/** The cycle plans in effect on a requirement, one line each with where it comes from ("Annual report · Every year (From IQF 4)"). */
export function PlanLines({ plans, internal }: { plans: NodeAssignment['plans']; internal: boolean }) {
  const { t } = useTranslation();
  if (!plans) return null;
  const active = plans.effective.filter((e) => !e.optedOut);
  const out = plans.effective.filter((e) => e.optedOut);
  return (
    <>
      <p className="mt-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('plans.label')}</p>
      {active.length === 0 && out.length === 0 ? <p className="text-xs text-muted-foreground" data-testid="hover-plans">{t('plans.none')}</p> : (
        <ul className="list-none space-y-0.5 text-xs" data-testid="hover-plans">
          {active.map((e) => <li key={e.templateId}><ContentText>{e.templateName}</ContentText> <span className="text-muted-foreground">· {recurrenceText(t, e.recurrence)} ({planSourceLabel(t, e.source, e.sourceCodes, internal)})</span></li>)}
          {out.map((e) => <li key={e.templateId} className="text-muted-foreground"><ContentText>{e.templateName}</ContentText> · {t('plans.optedOut')}</li>)}
        </ul>
      )}
    </>
  );
}

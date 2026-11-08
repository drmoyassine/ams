// The KPI documentation card (TASK-120): evidence is a KPI or a document. A KPI has a symbol (# count, % percent, $ money: the type),
// a scope (institution, unit, program, course), a formula (its unit and dimension come from it), a direction, targets and thresholds,
// its custodian and data source: the simple form of the KPI Institute's documentation sheet. Its numbers are the item's versions.
import { KPI_SCOPES, KPI_SYMBOLS, type KpiCard, type KpiScope } from '@ams/shared';
import { Shaded } from './accordion';
import { ContentText } from './content-text';
import { Input } from './ui/input';

export const SCOPE_LABEL: Record<KpiScope, string> = { institution: 'Institution', unit: 'Unit', program: 'Program', course: 'Course' };
export const SYMBOL_LABEL = { '#': 'Count', '%': 'Percent', $: 'Money' } as const;
const SYMBOL_TONE = { '#': 'bg-sky-50 text-sky-900 border-sky-200', '%': 'bg-emerald-50 text-emerald-900 border-emerald-200', $: 'bg-amber-50 text-amber-900 border-amber-200' } as const;

/** The tile on the left of a KPI's card: its symbol. */
export function KpiTile({ card }: { card: KpiCard }) {
  return (
    <span role="img" aria-label={`${SYMBOL_LABEL[card.symbol]} KPI`} data-testid="evidence-kind"
      className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-md border text-lg font-bold ${SYMBOL_TONE[card.symbol]}`}>{card.symbol}</span>
  );
}

/** The right-hand chips of a closed KPI card: scope, the trend that is good, and the next target. */
export function KpiChips({ card }: { card: KpiCard }) {
  const chip = 'rounded px-1.5 py-0.5';
  const target = card.target2027 ?? card.target2030;
  return (
    <>
      <span className={`${chip} bg-muted`} data-testid="kpi-scope">{SCOPE_LABEL[card.scope]}</span>
      {card.direction && <span className={`${chip} bg-muted`}>{card.direction === 'higher' ? '↑ higher is better' : '↓ lower is better'}</span>}
      {target && <span className={`${chip} bg-muted`} data-testid="kpi-target">Target {card.target2027 ? '2027' : '2030'}: {target}</span>}
    </>
  );
}

function Row({ label, value }: { label: string; value: string | undefined }) {
  return (
    <div className="grid grid-cols-[9rem_1fr] gap-2 border-b border-border/60 py-1 text-sm last:border-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{value ? <ContentText>{value}</ContentText> : <span className="text-muted-foreground">—</span>}</dd>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="space-y-1" aria-label={title}><Shaded>{title}</Shaded><dl>{children}</dl></section>;
}

/** The card as a read-only documentation form, in the sections of the KPI Institute's sheet. */
export function KpiCardView({ card, owner, unit }: { card: KpiCard; owner?: string | null | undefined; unit?: string | null | undefined }) {
  const trend = card.direction === 'higher' ? 'Higher' : card.direction === 'lower' ? 'Lower' : undefined;
  const nature = card.nature === 'lagging' ? 'Lagging (measures a result)' : card.nature === 'leading' ? 'Leading (measures an intermediate process)' : undefined;
  return (
    <div className="space-y-3" data-testid="kpi-card">
      <Section title="Definition and usage">
        <Row label="Type" value={`${card.symbol}  ${SYMBOL_LABEL[card.symbol]}`} />
        <Row label="Scope" value={`${SCOPE_LABEL[card.scope]}${card.scope === 'course' ? ' (one value set per course offering)' : ''}`} />
        <Row label="Purpose" value={card.purpose} />
        <Row label="Strategic objective" value={card.objective} />
      </Section>
      <Section title="Calculation">
        <Row label="Formula" value={card.formula} />
        <Row label="Built from" value={card.sources} />
        <Row label="Trend is good when figures are" value={trend} />
        <Row label="Focus" value={nature} />
      </Section>
      <Section title="Targets">
        <Row label="Baseline" value={card.baseline} />
        <Row label="Target 2027" value={card.target2027} />
        <Row label="Target 2030" value={card.target2030} />
        {(card.green || card.yellow || card.red) && (
          <div className="grid grid-cols-[9rem_1fr] gap-2 py-1 text-sm">
            <dt className="text-muted-foreground">Thresholds</dt>
            <dd className="flex flex-wrap gap-1.5">
              {card.green && <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-emerald-900">At or above: {card.green}</span>}
              {card.yellow && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-900">Near: {card.yellow}</span>}
              {card.red && <span className="rounded bg-red-100 px-1.5 py-0.5 text-red-900">Below: {card.red}</span>}
            </dd>
          </div>
        )}
      </Section>
      <Section title="Administration and data gathering">
        <Row label="Owner" value={[owner, unit].filter(Boolean).join(' · ') || undefined} />
        <Row label="Data custodian" value={card.custodian} />
        <Row label="Data source" value={card.dataSource} />
        <Row label="Limitations" value={card.limitations} />
      </Section>
    </div>
  );
}

// ---- The form ------------------------------------------------------------------------------------------------------------------

/** The card as the form edits it: every field text. */
export interface KpiDraft {
  symbol: KpiCard['symbol']; scope: KpiScope; direction: '' | 'higher' | 'lower'; nature: '' | 'lagging' | 'leading';
  formula: string; sources: string; objective: string; purpose: string; baseline: string; target2027: string; target2030: string;
  green: string; yellow: string; red: string; custodian: string; dataSource: string; limitations: string;
}
export const EMPTY_KPI: KpiDraft = {
  symbol: '#', scope: 'institution', direction: '', nature: '', formula: '', sources: '', objective: '', purpose: '', baseline: '', target2027: '', target2030: '',
  green: '', yellow: '', red: '', custodian: '', dataSource: '', limitations: '',
};
export const kpiDraftOf = (c: KpiCard | null | undefined): KpiDraft => ({ ...EMPTY_KPI, ...Object.fromEntries(Object.entries(c ?? {}).filter(([, v]) => v !== undefined)) } as KpiDraft);
/** The card the API takes: only what was filled in. */
export function kpiFromDraft(d: KpiDraft): KpiCard {
  const out: Record<string, string> = { symbol: d.symbol, scope: d.scope };
  for (const k of ['direction', 'nature', 'formula', 'sources', 'objective', 'purpose', 'baseline', 'target2027', 'target2030', 'green', 'yellow', 'red', 'custodian', 'dataSource', 'limitations'] as const) {
    const v = d[k].trim();
    if (v) out[k] = v;
  }
  return out as unknown as KpiCard;
}

const field = 'flex flex-col gap-1 text-sm';
const select = 'h-9 rounded-md border border-border bg-background px-2';
const area = 'rounded-md border border-border p-2 text-sm';

/** The KPI's documentation fields, in the same sections as the read view. */
export function KpiFields({ value, onChange }: { value: KpiDraft; onChange: (patch: Partial<KpiDraft>) => void }) {
  const set = <K extends keyof KpiDraft>(k: K) => (v: KpiDraft[K]) => onChange({ [k]: v } as Partial<KpiDraft>);
  const text = (k: keyof KpiDraft, label: string, placeholder?: string) => (
    <label className={field}>{label}<Input aria-label={label} dir="auto" placeholder={placeholder} value={value[k]} onChange={(e) => set(k)(e.target.value as never)} /></label>
  );
  return (
    <fieldset className="space-y-3 rounded-lg border border-border p-3" data-testid="kpi-fields">
      <legend className="px-1 text-sm font-semibold">KPI card</legend>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className={field}>Type (symbol)
          <select aria-label="KPI type" className={select} value={value.symbol} onChange={(e) => set('symbol')(e.target.value as KpiCard['symbol'])}>
            {KPI_SYMBOLS.map((s) => <option key={s} value={s}>{s}  {SYMBOL_LABEL[s]}</option>)}
          </select>
        </label>
        <label className={field}>Scope
          <select aria-label="KPI scope" className={select} value={value.scope} onChange={(e) => set('scope')(e.target.value as KpiScope)}>
            {KPI_SCOPES.map((s) => <option key={s} value={s}>{SCOPE_LABEL[s]}</option>)}
          </select>
        </label>
        <label className={field}>Trend is good when figures are
          <select aria-label="Trend" className={select} value={value.direction} onChange={(e) => set('direction')(e.target.value as KpiDraft['direction'])}>
            <option value="">Not set</option><option value="higher">Higher</option><option value="lower">Lower</option>
          </select>
        </label>
      </div>
      <p className="-mt-1 text-xs text-muted-foreground">The symbol is the type: # a count, % a percent, $ money. The unit and the cut come from the formula. A course-scope KPI has one set of values per course offering.</p>
      <label className={field}>Formula
        <textarea aria-label="Formula" rows={2} dir="auto" className={area} value={value.formula} onChange={(e) => set('formula')(e.target.value)} placeholder="Students at or above the score threshold ÷ students assessed" />
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        {text('sources', 'Built from', 'Other KPIs it is computed from')}
        <label className={field}>Focus
          <select aria-label="Focus" className={select} value={value.nature} onChange={(e) => set('nature')(e.target.value as KpiDraft['nature'])}>
            <option value="">Not set</option><option value="lagging">Lagging (a result)</option><option value="leading">Leading (an intermediate process)</option>
          </select>
        </label>
        {text('objective', 'Strategic objective')}
        {text('purpose', 'Purpose')}
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {text('baseline', 'Baseline')}{text('target2027', 'Target 2027')}{text('target2030', 'Target 2030')}
        {text('green', 'At or above (green)')}{text('yellow', 'Near (yellow)')}{text('red', 'Below (red)')}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {text('custodian', 'Data custodian')}{text('dataSource', 'Data source')}
      </div>
      {text('limitations', 'Limitations')}
    </fieldset>
  );
}

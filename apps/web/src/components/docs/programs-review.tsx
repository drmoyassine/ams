// The programs import's review (DEC-043): which existing program each proposal is (or a new one), and field by field what the
// document says beside what the program has now, each change with its own tick. PEOs and PLOs the same way, by code.
import { useQuery } from '@tanstack/react-query';
import type { ImportProposal, LearningOutcome, OrgUnit, Program } from '@ams/shared';
import { createApi } from '../../lib/api';
import type { DocumentsApi } from '../../lib/documents-api';
import { outcomesApi } from '../../lib/outcomes-api';
import { settingsApi } from '../../lib/settings-api';

type Item = {
  matchProgramId: string | null; matchReason: string | null; keep: string[];
  peos: { code: string | null; text: string; textAr: string | null }[]; plos: { code: string | null; text: string; textAr: string | null }[];
} & Record<string, unknown>;

const FIELDS: [string, string][] = [
  ['nameEn', 'Name (English)'], ['nameAr', 'Name (Arabic)'], ['degreeLevel', 'Program level'], ['code', 'Program code'], ['externalId', 'SIS code'], ['unitName', 'Unit'],
  ['mode', 'Mode'], ['credits', 'Credits'], ['durationYears', 'Years'], ['contactHours', 'Contact hours'], ['languageOfInstruction', 'Language'], ['mission', 'Mission'], ['vision', 'Vision'],
];
const MODE: Record<string, string> = { on_campus: 'On-campus', online: 'Online', blended: 'Blended' };
const LONG = new Set(['mission', 'vision']);
const fold = (v: unknown) => (v === null || v === undefined ? '' : String(v)).normalize('NFC').trim().toLowerCase().replace(/\s+/g, ' ');
const show = (k: string, v: unknown) => (v === null || v === undefined || v === '' ? '—' : k === 'mode' ? MODE[String(v)] ?? String(v) : String(v));

function useLookups(api: DocumentsApi) {
  const sapi = settingsApi(createApi(api.fetcher), api.fetcher);
  const programs = useQuery({ queryKey: ['programs'], queryFn: () => sapi.programs() });
  const units = useQuery({ queryKey: ['org-units'], queryFn: () => sapi.orgUnits() });
  return { programs: programs.data ?? [], units: units.data ?? [] };
}
function pathOf(units: OrgUnit[], id: string): string {
  const byId = new Map(units.map((u) => [u.id, u]));
  const out: string[] = []; let u = byId.get(id); const seen = new Set<string>();
  while (u && !seen.has(u.id)) { out.unshift(u.nameEn); seen.add(u.id); u = u.parentId ? byId.get(u.parentId) : undefined; }
  return out.join(' › ');
}
const label = (p: Program) => `${p.code ? `${p.code} · ` : ''}${p.nameEn} (${p.degreeLevel})${p.active ? '' : ' · inactive'}`;

/** The "Program" cell of the table: what the proposal does. */
export function ProgramMatchCell({ api, proposal }: { api: DocumentsApi; proposal: ImportProposal }) {
  const { programs } = useLookups(api);
  const it = proposal.effective as Item;
  const p = it.matchProgramId ? programs.find((x) => x.id === it.matchProgramId) : undefined;
  return it.matchProgramId
    ? <span className="rounded bg-sky-50 px-1.5 py-0.5 text-xs text-sky-900">Updates {p ? (p.code ?? p.nameEn) : '…'}</span>
    : <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-xs text-emerald-900">New program</span>;
}

/** The selected proposal in full: its match, and each field and outcome with what is there now and a tick to apply it. */
export function ProgramProposalDetail({ api, proposal, editable, save }: { api: DocumentsApi; proposal: ImportProposal; editable: boolean; save: (next: Item) => Promise<void> }) {
  const { programs, units } = useLookups(api);
  const it = proposal.effective as Item;
  const cur = it.matchProgramId ? programs.find((p) => p.id === it.matchProgramId) : undefined;
  const oapi = outcomesApi(api.fetcher);
  const outs = useQuery({ queryKey: ['program-outcomes', cur?.id], queryFn: () => oapi.programOutcomes(cur!.id), enabled: !!cur });
  const keep = new Set(it.keep);
  const toggle = (k: string) => { const n = new Set(keep); if (n.has(k)) n.delete(k); else n.add(k); void save({ ...it, keep: [...n] }); };
  const nowOf = (k: string): unknown => (!cur ? null : k === 'unitName' ? pathOf(units, cur.orgUnitId) : (cur as unknown as Record<string, unknown>)[k] ?? null);
  const rows = FIELDS.filter(([k]) => it[k] !== null && it[k] !== undefined && it[k] !== '');
  const outRows = (kind: 'peo' | 'plo', list: Item['peos'], existing: LearningOutcome[]) => list.map((o) => {
    const now = existing.find((e) => (o.code ? fold(e.code) === fold(o.code) : fold(e.textEn) === fold(o.text)));
    return { kind, key: `${kind}:${o.code ?? o.text}`, code: o.code ?? (now?.code ?? 'new'), now: now?.textEn ?? null, next: o.text, same: !!now && fold(now.textEn) === fold(o.text) };
  });
  const outcomeRows = [...outRows('peo', it.peos, outs.data?.peos ?? []), ...outRows('plo', it.plos, outs.data?.plos ?? [])];
  return (
    <section aria-label={`Details of ${proposal.label}`} className="space-y-3 rounded-md border border-border p-3">
      <div className="space-y-1">
        <label className="flex flex-wrap items-center gap-2 text-sm font-medium">Which program is this?
          <select aria-label={`Program for ${proposal.label}`} disabled={!editable} value={it.matchProgramId ?? ''} onChange={(e) => void save({ ...it, matchProgramId: e.target.value || null, keep: [] })}
            className="min-w-0 max-w-full rounded border border-border bg-background px-2 py-1 text-sm">
            <option value="">A new program</option>
            {[...programs].sort((a, b) => a.nameEn.localeCompare(b.nameEn)).map((p) => <option key={p.id} value={p.id}>{label(p)}</option>)}
          </select>
        </label>
        {it.matchReason && <p className="text-xs text-muted-foreground">The AI: {it.matchReason}</p>}
      </div>
      <div className="overflow-x-auto">
        <table aria-label={`Fields of ${proposal.label}`} className="w-full text-sm">
          <thead className="text-xs text-muted-foreground"><tr><th className="p-1 text-start">Field</th>{cur && <th className="p-1 text-start">Now</th>}<th className="p-1 text-start">{cur ? 'The document says' : 'Value'}</th>{cur && <th className="p-1 text-start">Apply</th>}</tr></thead>
          <tbody>
            {rows.map(([k, name]) => {
              const now = nowOf(k); const next = it[k]; const same = !!cur && fold(now) === fold(next);
              return (
                <tr key={k} className={`border-t border-border align-top ${same ? 'text-muted-foreground' : ''}`}>
                  <td className="p-1 whitespace-nowrap">{name}</td>
                  {cur && <td dir="auto" className={`p-1 ${LONG.has(k) ? 'max-w-72' : ''}`}>{show(k, now)}</td>}
                  <td dir="auto" className={`p-1 ${LONG.has(k) ? 'max-w-72' : ''}`}>{show(k, next)}</td>
                  {cur && <td className="p-1">{same ? <span className="text-xs">Same</span> : <input type="checkbox" aria-label={`Apply ${name} of ${proposal.label}`} disabled={!editable} checked={!keep.has(k)} onChange={() => toggle(k)} />}</td>}
                </tr>
              );
            })}
            {outcomeRows.map((o) => (
              <tr key={o.key} className={`border-t border-border align-top ${o.same ? 'text-muted-foreground' : ''}`}>
                <td className="p-1 whitespace-nowrap">{o.kind.toUpperCase()} {o.code}</td>
                {cur && <td dir="auto" className="max-w-72 p-1">{o.now ?? '— (new)'}</td>}
                <td dir="auto" className="max-w-72 p-1">{o.next}</td>
                {cur && <td className="p-1">{o.same ? <span className="text-xs">Same</span> : <input type="checkbox" aria-label={`Apply ${o.kind.toUpperCase()} ${o.code} of ${proposal.label}`} disabled={!editable} checked={!keep.has(o.key)} onChange={() => toggle(o.key)} />}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">{cur ? 'Ticked changes are written to the program when you apply; nothing is deleted. Untick what should stay as it is.' : 'Applying adds this program with these values. A new program needs its level and its unit.'}</p>
    </section>
  );
}

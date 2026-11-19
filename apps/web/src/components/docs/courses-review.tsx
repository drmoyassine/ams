// The courses import's review (DEC-044): which existing course each proposal is (or a new one), and field by field what the document says
// beside what the course has now, each change with its own tick. The record and the programs change at once; the content goes into the
// course's draft (DEC-042), so its "now" is the draft in progress, else the approved content.
import { useQuery } from '@tanstack/react-query';
import type { Course, ImportProposal, OrgUnit, SyllabusContent } from '@ams/shared';
import { createApi } from '../../lib/api';
import type { DocumentsApi } from '../../lib/documents-api';
import { outcomesApi } from '../../lib/outcomes-api';
import { settingsApi } from '../../lib/settings-api';
import { syllabusApi } from '../../lib/syllabus-api';

type Item = {
  matchCourseId: string | null; matchReason: string | null; keep: string[]; programs: string[];
  clos: { code: string | null; text: string; bloom: string | null }[];
} & Record<string, unknown>;

const RECORD: [string, string][] = [['code', 'Course code'], ['externalId', 'SIS code'], ['unitName', 'Unit'], ['level', 'Year of study']];
const CONTENT: [string, string][] = [['titleEn', 'Title'], ['credits', 'Credit hours'], ['contactLecture', 'Lecture hours'], ['contactLab', 'Lab hours'], ['description', 'Description'], ['methodology', 'Teaching methodology']];
const LONG = new Set(['description', 'methodology']);
const fold = (v: unknown) => (v === null || v === undefined ? '' : String(v)).normalize('NFC').trim().toLowerCase().replace(/\s+/g, ' ');
const codeKey = (v: unknown) => fold(v).replace(/[\s\-_.]/g, '');
const show = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : String(v));

function useCourses(api: DocumentsApi) {
  const oapi = outcomesApi(api.fetcher);
  const sapi = settingsApi(createApi(api.fetcher), api.fetcher);
  const courses = useQuery({ queryKey: ['courses'], queryFn: () => oapi.courses() });
  const units = useQuery({ queryKey: ['org-units'], queryFn: () => sapi.orgUnits() });
  const programs = useQuery({ queryKey: ['programs'], queryFn: () => sapi.programs() });
  return { courses: courses.data ?? [], units: units.data ?? [], programs: programs.data ?? [] };
}
function pathOf(units: OrgUnit[], id: string | null): string | null {
  if (!id) return null;
  const byId = new Map(units.map((u) => [u.id, u]));
  const out: string[] = []; let u = byId.get(id); const seen = new Set<string>();
  while (u && !seen.has(u.id)) { out.unshift(u.nameEn); seen.add(u.id); u = u.parentId ? byId.get(u.parentId) : undefined; }
  return out.join(' › ');
}
const contentValue = (c: SyllabusContent | null, k: string): unknown => (!c ? null
  : k === 'titleEn' ? c.info.titleEn : k === 'credits' ? c.info.credits : k === 'contactLecture' ? c.info.contactLecture : k === 'contactLab' ? c.info.contactLab : k === 'description' ? c.description.en : c.methodology);

/** The "Course" cell of the table: what the proposal does. */
export function CourseMatchCell({ api, proposal }: { api: DocumentsApi; proposal: ImportProposal }) {
  const { courses } = useCourses(api);
  const it = { matchCourseId: null, ...(proposal.effective as object) } as Item;
  const c = it.matchCourseId ? courses.find((x) => x.id === it.matchCourseId) : undefined;
  return it.matchCourseId
    ? <span className="rounded bg-sky-50 px-1.5 py-0.5 text-xs text-sky-900">Updates {c ? c.code : '…'}</span>
    : <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-xs text-emerald-900">New course</span>;
}

/** The selected proposal in full: its match, then the record, the programs and the content (into the draft), each change with a tick. */
export function CourseProposalDetail({ api, proposal, editable, save }: { api: DocumentsApi; proposal: ImportProposal; editable: boolean; save: (next: Item) => Promise<void> }) {
  const { courses, units, programs } = useCourses(api);
  const it = { programs: [], clos: [], keep: [], matchCourseId: null, matchReason: null, ...(proposal.effective as object) } as Item;
  const cur: Course | undefined = it.matchCourseId ? courses.find((c) => c.id === it.matchCourseId) : undefined;
  const ov = useQuery({ queryKey: ['syllabus', cur?.id], queryFn: () => syllabusApi(api.fetcher).overview(cur!.id), enabled: !!cur });
  const content = (ov.data?.open?.content ?? ov.data?.current?.content ?? null) as SyllabusContent | null;
  const locked = ov.data?.open && ov.data.open.status !== 'draft' ? ov.data.open.status : null;
  const keep = new Set(it.keep);
  const toggle = (k: string) => { const n = new Set(keep); if (n.has(k)) n.delete(k); else n.add(k); void save({ ...it, keep: [...n] }); };
  const programOf = (t: string) => programs.find((p) => (p.code && codeKey(p.code) === codeKey(t)) || fold(p.nameEn) === fold(t));
  const tick = (k: string, name: string, same: boolean) => (cur ? <td className="p-1">{same ? <span className="text-xs">Same</span> : <input type="checkbox" aria-label={`Apply ${name} of ${proposal.label}`} disabled={!editable} checked={!keep.has(k)} onChange={() => toggle(k)} />}</td> : null);
  const row = (k: string, name: string, now: unknown, next: unknown, same: boolean) => (
    <tr key={k} className={`border-t border-border align-top ${same ? 'text-muted-foreground' : ''}`}>
      <td className="p-1 whitespace-nowrap">{name}</td>
      {cur && <td dir="auto" className={`p-1 ${LONG.has(k) ? 'max-w-72' : ''}`}>{show(now)}</td>}
      <td dir="auto" className={`p-1 ${LONG.has(k) ? 'max-w-72' : ''}`}>{show(next)}</td>
      {tick(k, name, same)}
    </tr>
  );
  const head = (title: string) => <tr><th colSpan={cur ? 4 : 2} className="pt-3 pb-1 text-start text-xs font-semibold uppercase text-muted-foreground">{title}</th></tr>;
  const present = (k: string) => it[k] !== null && it[k] !== undefined && it[k] !== '';
  return (
    <section aria-label={`Details of ${proposal.label}`} className="space-y-3 rounded-md border border-border p-3">
      <div className="space-y-1">
        <label className="flex flex-wrap items-center gap-2 text-sm font-medium">Which course is this?
          <select aria-label={`Course for ${proposal.label}`} disabled={!editable} value={it.matchCourseId ?? ''} onChange={(e) => void save({ ...it, matchCourseId: e.target.value || null, keep: [] })}
            className="min-w-0 max-w-full rounded border border-border bg-background px-2 py-1 text-sm">
            <option value="">A new course</option>
            {[...courses].sort((a, b) => a.code.localeCompare(b.code)).map((c) => <option key={c.id} value={c.id}>{c.code} · {c.titleEn}{c.active ? '' : ' · inactive'}</option>)}
          </select>
        </label>
        {it.matchReason && <p className="text-xs text-muted-foreground">The AI: {it.matchReason}</p>}
        {locked && <p role="note" className="text-xs text-amber-900">Its content is {locked === 'in_review' ? 'in review' : 'endorsed'}: only the record and the programs would change.</p>}
      </div>
      <div className="overflow-x-auto">
        <table aria-label={`Fields of ${proposal.label}`} className="w-full text-sm">
          <thead className="text-xs text-muted-foreground"><tr><th className="p-1 text-start">Field</th>{cur && <th className="p-1 text-start">Now</th>}<th className="p-1 text-start">{cur ? 'The document says' : 'Value'}</th>{cur && <th className="p-1 text-start">Apply</th>}</tr></thead>
          <tbody>
            {head('Record (changes at once)')}
            {RECORD.filter(([k]) => present(k)).map(([k, name]) => {
              const now = !cur ? null : k === 'unitName' ? pathOf(units, cur.orgUnitId) : k === 'level' ? cur.level : (cur as unknown as Record<string, unknown>)[k];
              return row(k, name, now, it[k], !!cur && (k === 'code' ? codeKey(now) === codeKey(it[k]) : fold(now) === fold(it[k])));
            })}
            {it.programs.map((t) => {
              const p = programOf(t); const already = !!cur && !!p && cur.programIds.includes(p.id);
              return row(`program:${t}`, 'Serves program', already ? (p!.code ?? p!.nameEn) : null, p ? `${p.code ?? ''} ${p.nameEn}`.trim() : `${t} (no such program)`, already);
            })}
            {head(cur ? 'Content (goes into the draft for approval)' : 'Content')}
            {CONTENT.filter(([k]) => present(k)).map(([k, name]) => { const now = contentValue(content, k); return row(k, name, now, it[k], !!cur && fold(now) === fold(it[k])); })}
            {it.clos.map((o) => {
              const now = content?.clos.find((c) => (o.code ? codeKey(c.code) === codeKey(o.code) : fold(c.textEn) === fold(o.text)));
              return row(`clo:${o.code ?? o.text}`, `CLO ${o.code ?? now?.code ?? 'new'}`, now ? now.textEn : cur ? '— (new)' : null, `${o.text}${o.bloom ? ` (${o.bloom})` : ''}`, !!now && fold(now.textEn) === fold(o.text));
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">{cur
        ? 'Ticked record changes and programs apply at once; ticked content goes into the course\'s draft, which its coordinator submits for approval. Nothing is deleted.'
        : 'Applying adds this course (it needs a code; its unit, credit hours and a program are flagged when missing) and puts its content into a draft.'}</p>
    </section>
  );
}

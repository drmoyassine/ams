// The catalog as a document (DEC-046, step 5): the university catalog, or one program's, generated from a snapshot (a published version, or the
// draft). Front matter, General education, each college with its programs (record, outcomes, degree requirements by block, concentrations, the
// study plan by year and term, minors), then the course descriptions as "CODE Title (lecture-lab-credits)" with requisites. Nothing here is typed
// twice: it is all read from the snapshot. The same component renders the screen, the print and the Word file.
import { describeRequisites, BLOCK_LABEL, REQUIREMENT_BLOCKS, type CatalogSnapshot, type RequirementBlock, type SnapCourse, type SnapProgram } from '@ams/shared';

export const CATALOG_CSS = `
.catalog { font-family: Georgia, 'Times New Roman', serif; line-height: 1.45; color: #111; overflow-wrap: anywhere; }
.catalog h1 { font-size: 28px; margin: 0 0 4px; } .catalog h2 { font-size: 22px; margin: 28px 0 8px; border-bottom: 2px solid #444; padding-bottom: 4px; }
.catalog h3 { font-size: 18px; margin: 20px 0 6px; } .catalog h4 { font-size: 15px; margin: 14px 0 4px; } .catalog h5 { font-size: 13px; margin: 10px 0 2px; text-transform: uppercase; color: #444; }
.catalog h1, .catalog h2, .catalog h3, .catalog h4, .catalog h5 { font-weight: 700; }
.catalog p { margin: 4px 0; } .catalog ul, .catalog ol { margin: 4px 0 4px 22px; padding: 0; } .catalog ul { list-style: disc; } .catalog ol { list-style: decimal; }
.catalog table { border-collapse: collapse; width: 100%; margin: 6px 0 10px; font-size: 13px; } .catalog th, .catalog td { border: 1px solid #999; padding: 3px 6px; text-align: left; vertical-align: top; }
.catalog th { background: #eee; } .catalog td.n, .catalog th.n { text-align: right; white-space: nowrap; }
.catalog .muted { color: #555; } .catalog .ar { direction: rtl; unicode-bidi: plaintext; } .catalog .total td { font-weight: bold; background: #f6f6f6; }
.catalog .course { margin: 8px 0; break-inside: avoid; } .catalog .facts { margin: 4px 0; font-size: 13px; }
@media screen and (max-width: 700px) { .catalog table { display: block; overflow-x: auto; } }
@media print { .catalog h2 { break-after: avoid; } .catalog section.program { break-before: page; } }
`;

const fmt = (n: number | null | undefined) => (n === null || n === undefined ? '—' : String(Math.round(n * 10) / 10));
const LEVEL: Record<string, string> = { associate: 'Associate', bachelor: 'Bachelor', master: 'Master', doctorate: 'Doctorate', diploma: 'Diploma', certificate: 'Certificate' };
const MODE: Record<string, string> = { on_campus: 'On-campus', online: 'Online', blended: 'Blended' };
const ROMAN = (n: number) => String(n);
const prefixOf = (code: string) => (/^[A-Za-z]+/.exec(code)?.[0] ?? code).toUpperCase();
const idOf = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');

interface Meta { editionLabel: string; versionNo: number | null; publishedAt: string | null }

function Names({ en, ar }: { en: string; ar: string | null }) {
  return <>{en}{ar && <> <span className="ar" dir="rtl">{ar}</span></>}</>;
}

function CourseRows({ codes, byCode, withRole }: { codes: { code: string; role?: string }[]; byCode: Map<string, SnapCourse>; withRole?: boolean }) {
  return (
    <>
      {codes.map((r) => { const c = byCode.get(r.code); return (
        <tr key={r.code}><td>{r.code}</td><td>{c?.titleEn ?? ''}</td><td className="n">{fmt(c?.credits)}</td>{withRole && <td>{r.role === 'service' ? 'Service' : r.role === 'elective' ? 'Elective' : 'Core'}</td>}</tr>
      ); })}
    </>
  );
}

/** One block of a degree's requirements: its core courses, elective courses and slots, with the credits planned and the credits asked. */
function BlockTable({ program, block, concentration, byCode, title }: { program: SnapProgram; block: RequirementBlock; concentration: string | null; byCode: Map<string, SnapCourse>; title: string }) {
  const concsOf = (r: { concentrations?: string[]; concentration?: string | null }) => r.concentrations ?? (r.concentration ? [r.concentration] : []);
  const rows = program.plan.filter((r) => r.block === block && (concentration ? concsOf(r).includes(concentration) : concsOf(r).length === 0));
  const slots = program.slots.filter((s) => s.block === block && (s.concentration ?? null) === (concentration ?? null));
  const asked = (req: string) => program.blocks.find((b) => b.block === block && (b.concentration ?? null) === (concentration ?? null) && b.requirement === req)?.credits ?? null;
  if (!rows.length && !slots.length && asked('core') === null && asked('elective') === null) return null;
  const credits = (r: { course: string }) => byCode.get(r.course)?.credits ?? 0;
  const core = rows.filter((r) => r.role !== 'elective');
  const elective = rows.filter((r) => r.role === 'elective');
  const coreTotal = core.reduce((n, r) => n + credits(r), 0) + slots.filter((s) => s.requirement === 'core').reduce((n, s) => n + s.credits, 0);
  const electiveTotal = elective.reduce((n, r) => n + credits(r), 0) + slots.filter((s) => s.requirement !== 'core').reduce((n, s) => n + s.credits, 0);
  return (
    <>
      <h5>{title}: {fmt(coreTotal + electiveTotal)} credits</h5>
      <table>
        <thead><tr><th>Code</th><th>Course</th><th className="n">Credits</th></tr></thead>
        <tbody>
          {core.length > 0 && <tr><td colSpan={3}><b>Required{asked('core') !== null ? ` (${fmt(asked('core'))} credits)` : ''}</b></td></tr>}
          <CourseRows codes={core.map((r) => ({ code: r.course }))} byCode={byCode} />
          {slots.filter((s) => s.requirement === 'core').map((s, i) => <tr key={`c${i}`}><td colSpan={2}>{s.name}{s.rule ? <span className="muted"> — {s.rule}</span> : ''}</td><td className="n">{fmt(s.credits)}</td></tr>)}
          {(elective.length > 0 || slots.some((s) => s.requirement !== 'core') || asked('elective') !== null) && <tr><td colSpan={3}><b>Electives{asked('elective') !== null ? ` (${fmt(asked('elective'))} credits)` : ''}</b></td></tr>}
          <CourseRows codes={elective.map((r) => ({ code: r.course }))} byCode={byCode} />
          {slots.filter((s) => s.requirement !== 'core').map((s, i) => <tr key={`e${i}`}><td colSpan={2}>{s.name}{s.rule ? <span className="muted"> — {s.rule}</span> : ''}</td><td className="n">{fmt(s.credits)}</td></tr>)}
        </tbody>
      </table>
    </>
  );
}

function ProgramSection({ program: p, snapshot, byCode }: { program: SnapProgram; snapshot: CatalogSnapshot; byCode: Map<string, SnapCourse> }) {
  const minor = p.type === 'minor';
  const planned = p.plan.filter((r) => r.year !== null);
  const terms = [...new Set([...planned.map((r) => `${r.year}|${r.term ?? 0}`), ...p.slots.filter((s) => s.year !== null).map((s) => `${s.year}|${s.term ?? 0}`)])]
    .map((k) => k.split('|').map(Number) as [number, number]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const conc = (code: string | null) => (code ? p.concentrations.find((c) => c.code === code)?.nameEn ?? code : null);
  return (
    <section className="program" id={`program-${idOf(p.code)}`} aria-label={`Program ${p.code}`}>
      <h3><Names en={p.nameEn} ar={p.nameAr} /></h3>
      <p className="facts muted">{p.code} · {minor ? 'Minor' : LEVEL[p.level] ?? p.level}{p.unit ? ` · ${p.unit}` : ''}</p>
      <table className="facts"><tbody>
        <tr><th>Credits</th><td>{fmt(p.credits)}</td>{!minor && <><th>Duration</th><td>{p.durationYears ? `${fmt(p.durationYears)} years` : '—'}</td></>}</tr>
        {!minor && <tr><th>Mode</th><td>{p.mode ? MODE[p.mode] ?? p.mode : '—'}</td><th>Contact hours</th><td>{fmt(p.contactHours)}</td></tr>}
        <tr><th>Language of instruction</th><td colSpan={3}>{p.language ?? '—'}</td></tr>
      </tbody></table>
      {p.mission && <><h4>Mission</h4><p dir="auto">{p.mission}</p></>}
      {p.vision && <><h4>Vision</h4><p dir="auto">{p.vision}</p></>}
      {p.peos.length > 0 && <><h4>Program educational objectives</h4><ol>{p.peos.map((o) => <li key={o.code} dir="auto"><b>{o.code}</b> {o.textEn}</li>)}</ol></>}
      {p.plos.length > 0 && <><h4>Program learning outcomes</h4><ol>{p.plos.map((o) => <li key={o.code} dir="auto"><b>{o.code}</b> {o.textEn}{o.ilos.length ? <span className="muted"> (ILOs: {o.ilos.join(', ')})</span> : ''}</li>)}</ol></>}

      <h4>Degree requirements</h4>
      {!minor && (p.gened?.credits ?? snapshot.gened.credits) !== null && <p className="muted">General education: {fmt(p.gened?.credits ?? snapshot.gened.credits)} credits{p.gened?.areas.some((a) => a.minCredits > 0) ? ` (${p.gened.areas.filter((a) => a.minCredits > 0).map((a) => `${snapshot.gened.areas.find((x) => x.code === a.code)?.nameEn ?? a.code} at least ${fmt(a.minCredits)}`).join(', ')})` : ''}, from the areas described in the General Education section.{(p.gened?.freeElectiveCredits ?? null) ? ` Free electives: ${fmt(p.gened.freeElectiveCredits)} credits.` : ''}</p>}
      {(['general_education', 'free_elective', 'college', 'major'] as const).map((b) => minor && (b === 'general_education' || b === 'free_elective') ? null : <BlockTable key={b} program={p} block={b} concentration={null} byCode={byCode} title={BLOCK_LABEL[b]} />)}
      {p.concentrations.map((c) => <BlockTable key={c.code} program={p} block="concentration" concentration={c.code} byCode={byCode} title={`Concentration: ${c.nameEn}`} />)}
      {p.plan.some((r) => !r.block) && (
        <><h5>Other courses</h5><table><tbody><CourseRows codes={p.plan.filter((r) => !r.block).map((r) => ({ code: r.course }))} byCode={byCode} /></tbody></table></>
      )}

      {terms.length > 0 && !minor && (
        <>
          <h4>Study plan</h4>
          {terms.map(([y, t]) => {
            const rows = planned.filter((r) => r.year === y && (r.term ?? 0) === t);
            const slots = p.slots.filter((s) => s.year === y && (s.term ?? 0) === t);
            const total = rows.reduce((n, r) => n + (byCode.get(r.course)?.credits ?? 0), 0) + slots.reduce((n, s) => n + s.credits, 0);
            return (
              <table key={`${y}-${t}`} aria-label={`Year ${y}${t ? ` term ${t}` : ''}`}>
                <thead><tr><th colSpan={3}>Year {ROMAN(y)}{t ? `, term ${t}` : ''}</th></tr></thead>
                <tbody>
                  {rows.map((r) => <tr key={r.course}><td>{r.course}</td><td>{byCode.get(r.course)?.titleEn ?? ''}{(r.concentrations ?? []).length ? <span className="muted"> ({(r.concentrations ?? []).map((x) => conc(x)).join(' or ')})</span> : ''}</td><td className="n">{fmt(byCode.get(r.course)?.credits)}</td></tr>)}
                  {slots.map((s, i) => <tr key={`s${i}`}><td colSpan={2}>{s.name}{s.rule ? <span className="muted"> — {s.rule}</span> : ''}{s.concentration ? <span className="muted"> ({conc(s.concentration)})</span> : ''}</td><td className="n">{fmt(s.credits)}</td></tr>)}
                  <tr className="total"><td colSpan={2}>Total</td><td className="n">{fmt(total)}</td></tr>
                </tbody>
              </table>
            );
          })}
        </>
      )}
    </section>
  );
}

export function CatalogDocument({ snapshot, meta, program }: { snapshot: CatalogSnapshot; meta: Meta; program?: string | null }) {
  const byCode = new Map(snapshot.courses.map((c) => [c.code, c]));
  const programs = program ? snapshot.programs.filter((p) => p.code === program) : snapshot.programs;
  const colleges = [...new Set(programs.map((p) => p.college ?? 'Other programs'))].sort((a, b) => a.localeCompare(b));
  // The courses a (sliced) catalog describes: those in the shown programs' plans, or all of them.
  const shown = program ? new Set(programs.flatMap((p) => p.plan.map((r) => r.course))) : null;
  const courses = snapshot.courses.filter((c) => !shown || shown.has(c.code));
  const prefixes = [...new Set(courses.map((c) => prefixOf(c.code)))].sort();
  const codeOf = (id: string) => id;
  const when = meta.publishedAt ? new Date(meta.publishedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : null;
  return (
    <article className="catalog" aria-label="Catalog">
      <header>
        <h1><Names en={snapshot.institution.nameEn} ar={snapshot.institution.nameAr} /></h1>
        <p><b>{program ? `Program catalog: ${programs[0]?.nameEn ?? program}` : 'University catalog'}</b> · {meta.versionNo ? `${meta.editionLabel}, version ${meta.versionNo}` : 'Draft (not published)'}{when ? ` · published ${when}` : ''}</p>
      </header>
      <nav aria-label="Contents">
        <h2>Contents</h2>
        <ol>
          <li><a href="#general-education">General education</a></li>
          {colleges.map((c) => <li key={c}><a href={`#college-${idOf(c)}`}>{c}</a><ul>{programs.filter((p) => (p.college ?? 'Other programs') === c).map((p) => <li key={p.code}><a href={`#program-${idOf(p.code)}`}>{p.nameEn}{p.type === 'minor' ? ' (minor)' : ''}</a></li>)}</ul></li>)}
          <li><a href="#courses">Course descriptions</a></li>
        </ol>
      </nav>

      <section id="general-education" aria-label="General education">
        <h2>General education</h2>
        {snapshot.gened.credits !== null && <p>Every degree includes {fmt(snapshot.gened.credits)} credits of general education{snapshot.gened.areas.length ? ', in these areas' : ''}.</p>}
        {snapshot.gened.areas.map((a) => (
          <div key={a.code}>
            <h4><Names en={a.nameEn} ar={a.nameAr} /> <span className="muted">(at least {fmt(a.minCredits)} credits)</span></h4>
            {a.courses.length > 0 && <table><thead><tr><th>Code</th><th>Course</th><th className="n">Credits</th></tr></thead><tbody><CourseRows codes={a.courses.map((code) => ({ code }))} byCode={byCode} /></tbody></table>}
          </div>
        ))}
        {snapshot.gened.areas.length === 0 && <p className="muted">The areas of general education are not defined yet.</p>}
      </section>

      {colleges.map((college) => (
        <section key={college} id={`college-${idOf(college)}`} aria-label={`College ${college}`}>
          <h2>{college}</h2>
          {programs.filter((p) => (p.college ?? 'Other programs') === college).sort((a, b) => Number(a.type === 'minor') - Number(b.type === 'minor') || a.nameEn.localeCompare(b.nameEn)).map((p) => <ProgramSection key={p.code} program={p} snapshot={snapshot} byCode={byCode} />)}
        </section>
      ))}

      <section id="courses" aria-label="Course descriptions">
        <h2>Course descriptions</h2>
        <p className="muted">Course titles are followed by (lecture hours - lab hours - credits).</p>
        {prefixes.map((pre) => (
          <div key={pre}>
            <h3>{pre}</h3>
            {courses.filter((c) => prefixOf(c.code) === pre).map((c) => (
              <div key={c.code} className="course" id={`course-${idOf(c.code)}`}>
                <h4>{c.code} {c.titleEn} <span className="muted">({c.lecture ?? 0}-{c.lab ?? 0}-{fmt(c.credits ?? 0)})</span></h4>
                {c.prerequisites.length > 0 && <p><b>Prerequisites:</b> {describeRequisites(c.prerequisites, codeOf)}</p>}
                {c.corequisites.length > 0 && <p><b>Co-requisites:</b> {describeRequisites(c.corequisites, codeOf)}</p>}
                {c.otherRequirements && <p><b>Other requirements:</b> {c.otherRequirements}</p>}
                {c.description && <p dir="auto">{c.description}</p>}
              </div>
            ))}
          </div>
        ))}
        {courses.length === 0 && <p className="muted">No courses.</p>}
      </section>
    </article>
  );
}

export { REQUIREMENT_BLOCKS };

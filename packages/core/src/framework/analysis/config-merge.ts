// Pure part of the "config_write" stage (step H): check every proposed configuration item against the stored pages, merge what
// overlapping windows proposed twice, and turn what survives into the shapes of the version's configuration (PRD 7.4-7.6,
// 10.2), validated with the same schemas the editors and the importer use. No database, no AI.
//
// The rules, in one place:
//   * an item is SOUND when its quote is found on the cited page (or a neighbour) and its name, label or title is in the
//     source text. Anything else is FLAGGED: it stays in the run log and the report and is not written;
//   * words are copied: a name, label or title is the accreditor's own, never rewritten. Codes and keys are derived from
//     them deterministically (a printed code when valid, else a lower-case ASCII slug, else a numbered fallback);
//   * dates are never converted. A milestone whose document states a timing or a repeat is written with the words copied
//     into `due_text`, `due: null` and `due_pending: true`: checkFrameworkConfig reports it until a reviewer sets the rule;
//   * what the configuration schemas refuse is flagged too, with their message, never written as valid configuration.
import {
  checkFrameworkConfig, DecisionVocabSchema, FindingVocabSchema, LifecycleTemplateSchema, PHASE_TYPES, ReportTemplateConfigSchema, ResponseVocabSchema, RatingMethodSchema,
  type ConfigItemResult, type ConfigTarget, type SectionTemplate,
} from '@ams/shared';
import { normalizeQuoteText, textInPages, verifyQuote, type PageTexts } from '../quote-match.js';
import { LOW_CONFIDENCE } from './merge.js';
import type { LifecycleItem, TemplateItem, VocabItem } from './config-schemas.js';

export type ConfigAnswerItem = LifecycleItem | VocabItem | TemplateItem;

/** One item as the config_extract stage logged it: the model's answer plus where it came from. */
export interface RawConfigItem {
  /** The extraction_item row, so its verification result can be recorded. */
  id: string;
  documentId: string;
  target: ConfigTarget;
  seq: number;
  window: number;
  item: ConfigAnswerItem;
}

export interface ConfigDoc { id: string; title: string; language: string; role: string }
export interface TemplateHint { name: string | null; kind: string | null }

/** Where an item was found, kept with the configuration (framework_version.config_found) so the Settings tabs can show it. */
export interface ConfigRef { documentId: string; document: string; page: number; quote: string; verified: boolean }

export interface ConfigItemCheck { quoteVerified: boolean; page: number; flags: string[] }

type Lifecycle = ReturnType<typeof LifecycleTemplateSchema.parse>;
type Vocab<T> = { value: T[]; refs: Record<string, ConfigRef> };
export interface BuiltTemplate {
  key: string; name: string; kind: string; language: string; structure: { sections: SectionTemplate[] }; word_limit: number | null; requires_attestation: boolean;
  documentId: string; source: ConfigRef; sectionRefs: Record<string, ConfigRef>;
}

export interface ConfigBuild {
  lifecycle: { value: Lifecycle | null; refs: Record<string, ConfigRef> };
  decision: Vocab<ReturnType<typeof DecisionVocabSchema.parse>[number]>;
  finding: Vocab<ReturnType<typeof FindingVocabSchema.parse>[number]>;
  response: Vocab<ReturnType<typeof ResponseVocabSchema.parse>[number]>;
  rating: { value: NonNullable<ReturnType<typeof RatingMethodSchema.parse>> | null; ref: ConfigRef | null };
  templates: BuiltTemplate[];
  /** Every item with what became of it; `kept` is applied later, when the sections a person edited are known. */
  results: ConfigItemResult[];
  /** Per logged item: whether its quote was found, the page it is on, and the flags it carries after the checks. */
  checks: Map<string, ConfigItemCheck>;
  duplicatesMerged: number;
}

// ---- Words for the flags --------------------------------------------------------------------------------------------

export const CONFIG_REASON: Record<string, string> = {
  quote_not_found: 'its quote was not found on the cited page',
  text_not_in_source: 'its name is not on the cited page as written',
  low_confidence: 'the analysis was not sure about it',
  phase_missing: 'the stage it belongs to is not known',
  phase_name_assumed: 'the document does not name this stage; it is named after its type, rename it if you like',
  type_assumed: 'the document does not say what kind of step this is; it is set to "task"',
  due_pending: 'the reviewer must set the due rule',
  description_not_in_source: 'the sentence kept with it was not found on the page, so it was left out',
  due_text_not_in_source: 'the timing words were not found on the page, so they were left out',
  deliverable_not_matched: 'the report it delivers is not among the templates; link it by hand',
  outcome_not_stated: 'no decision outcome could be chosen for it; add it by hand',
  requires_action_not_stated: 'the document does not say whether it requires action; add it by hand',
  reply_kind_needs_template: 'the reply is a report; choose its template by hand',
  rating_incomplete: 'the document does not give the whole rating method (scale, labels, rated level, how ratings combine); add it by hand',
  prompt_not_in_source: 'the instructions were not found on the page as written, so they were left out',
  columns_missing: 'a table needs its columns; add this section by hand',
  enum_options_missing: 'a column that offers choices has none listed; it was set to text',
  parent_not_found: 'its parent section was not found, so it sits at the top level',
  no_sections: 'no valid sections were found for this template',
};

const wordsOf = (reasons: string[]) => reasons.map((r) => CONFIG_REASON[r] ?? r);
const uniq = <T>(xs: T[]) => [...new Set(xs)];
const norm = (s: string) => normalizeQuoteText(s);

// ---- Keys and codes -------------------------------------------------------------------------------------------------

/** A lower-case ASCII slug of a name (accents dropped); '' for a name with no Latin letters or digits (Arabic, ...). */
export function slug(name: string, max = 40): string {
  return name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, max).replace(/_+$/g, '');
}
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
/** The first of base, base_2, base_3 ... not yet used; records it. */
export function uniqueKey(base: string, used: Set<string>): string {
  let k = base;
  for (let n = 2; used.has(k.toLowerCase()); n++) k = `${base}_${n}`;
  used.add(k.toLowerCase());
  return k;
}
/** The code of a vocabulary entry: the printed code when it is a valid key, else the label's slug, else prefix_n. Unique. */
export function deriveCode(printed: string | null | undefined, label: string, prefix: string, ordinal: number, used: Set<string>): string {
  const p = printed?.normalize('NFC').trim();
  const base = p && KEY_RE.test(p) ? p : slug(label) || `${prefix}_${ordinal}`;
  return uniqueKey(base, used);
}
/** A section key from the number printed with its heading ("2.1", "Section B", "T5-1"); '' when there is none. */
export function sectionKeyOf(number: string | null | undefined): string {
  const k = (number ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/-+/g, '-').replace(/^[^A-Za-z0-9]+|[-.]+$/g, '');
  return KEY_RE.test(k) ? k : '';
}

const PHASE_NAME: Record<(typeof PHASE_TYPES)[number], string> = {
  eligibility: 'Eligibility', self_study: 'Self-study', review: 'Review', decision: 'Decision', maintenance: 'Maintenance',
};

// ---- Verification ---------------------------------------------------------------------------------------------------

/** The name, label or title an item must be found under in the source. */
const nameOf = (r: RawConfigItem): string => {
  const i = r.item;
  if ('title' in i) return i.title;
  if ('label' in i) return i.label;
  return i.name;
};

function checkAll(raw: RawConfigItem[], pages: ReadonlyMap<string, PageTexts>): Map<string, ConfigItemCheck> {
  const checks = new Map<string, ConfigItemCheck>();
  const none: PageTexts = new Map();
  for (const r of raw) {
    const pt = pages.get(r.documentId) ?? none;
    const flags = [...r.item.flags];
    const q = verifyQuote(r.item.source.quote, pt, r.item.source.page);
    const page = q.page ?? r.item.source.page;
    if (!q.verified) flags.push('quote_not_found');
    else if (q.page !== r.item.source.page) flags.push('page_corrected');
    const name = nameOf(r).trim();
    // A rating method's label is only its heading; the labels of the scale are checked with it.
    if (!name || !textInPages(name, pt, page)) flags.push('text_not_in_source');
    if ((r.item.confidence ?? 1) < LOW_CONFIDENCE) flags.push('low_confidence');
    checks.set(r.id, { quoteVerified: q.verified, page, flags: uniq(flags) });
  }
  return checks;
}

/** Sound: quote found and the name on the page. */
const sound = (c: ConfigItemCheck) => c.quoteVerified && !c.flags.includes('text_not_in_source');
const reasonsOf = (c: ConfigItemCheck) => c.flags.filter((f) => f in CONFIG_REASON && f !== 'page_corrected');

const better = (a: RawConfigItem, b: RawConfigItem, checks: Map<string, ConfigItemCheck>) => {
  const sa = Number(sound(checks.get(a.id)!));
  const sb = Number(sound(checks.get(b.id)!));
  if (sa !== sb) return sa > sb;
  const la = (a.item.text ?? '').length + JSON.stringify(a.item).length / 100;
  const lb = (b.item.text ?? '').length + JSON.stringify(b.item).length / 100;
  return la >= lb;
};

/** Keeps one item per key (the sounder, then the fuller one; the first on a tie), in reading order. */
function dedupe<T extends RawConfigItem>(list: T[], keyOf: (r: T) => string, checks: Map<string, ConfigItemCheck>): { kept: T[]; merged: number } {
  const byKey = new Map<string, T>();
  let merged = 0;
  for (const r of list) {
    const k = keyOf(r);
    const cur = byKey.get(k);
    if (!cur) { byKey.set(k, r); continue; }
    merged++;
    if (better(r, cur, checks) && !better(cur, r, checks)) byKey.set(k, { ...r, seq: Math.min(r.seq, cur.seq) } as T);
    else byKey.set(k, { ...cur, seq: Math.min(r.seq, cur.seq) } as T);
  }
  return { kept: [...byKey.values()].sort((a, b) => a.seq - b.seq), merged };
}

// ---- The build ------------------------------------------------------------------------------------------------------

export function buildConfig(input: {
  raw: RawConfigItem[];
  docs: ReadonlyMap<string, ConfigDoc>;
  pages: ReadonlyMap<string, PageTexts>;
  templateHints: ReadonlyMap<string, TemplateHint>;
  /** Templates a person made (they are not rewritten): their keys and names, so a milestone's deliverable can point at them. */
  otherTemplates?: { key: string; name: string }[];
}): ConfigBuild {
  const { docs, pages } = input;
  const raw = [...input.raw].sort((a, b) => a.seq - b.seq);
  const checks = checkAll(raw, pages);
  const results: ConfigItemResult[] = [];
  let duplicatesMerged = 0;
  const none: PageTexts = new Map();
  const docOf = (id: string) => docs.get(id) ?? { id, title: 'source', language: 'en', role: 'other' };
  const refOf = (r: RawConfigItem): ConfigRef => {
    const c = checks.get(r.id)!;
    return { documentId: r.documentId, document: docOf(r.documentId).title, page: c.page, quote: r.item.source.quote.trim(), verified: c.quoteVerified };
  };
  const result = (r: RawConfigItem, o: Pick<ConfigItemResult, 'group' | 'ref' | 'label' | 'detail'> & Partial<ConfigItemResult>): ConfigItemResult => {
    const c = checks.get(r.id)!;
    return {
      documentId: r.documentId, page: c.page, quote: r.item.source.quote.trim(), status: 'written', reasons: [], ...o,
    };
  };
  /** An item that failed the checks, kept out and listed. */
  const flag = (r: RawConfigItem, group: ConfigItemResult['group'], label: string, detail: string | null, extra: string[] = []) => {
    const c = checks.get(r.id)!;
    results.push(result(r, { group, ref: null, label: label.trim(), detail, status: 'flagged', reasons: wordsOf(uniq([...reasonsOf(c), ...extra])) }));
  };
  const textFound = (text: string | null | undefined, r: RawConfigItem) => !!text?.trim() && textInPages(text, pages.get(r.documentId) ?? none, checks.get(r.id)!.page);

  // ---- templates first: a milestone can then name the template it delivers
  const templates = buildTemplates(raw.filter((r) => r.target === 'template') as (RawConfigItem & { item: TemplateItem })[], {
    checks, docs, pages, templateHints: input.templateHints, results, refOf, result, flag, textFound,
  });
  duplicatesMerged += templates.merged;

  // ---- lifecycle
  const life = buildLifecycle(raw.filter((r) => r.target === 'lifecycle') as (RawConfigItem & { item: LifecycleItem })[], {
    checks, docs, results, refOf, result, flag, textFound,
    templateNames: [...templates.built.map((t) => ({ key: t.key, name: t.name })), ...(input.otherTemplates ?? [])],
  });
  duplicatesMerged += life.merged;

  // ---- vocabularies
  const vocab = buildVocab(raw.filter((r) => r.target === 'vocab') as (RawConfigItem & { item: VocabItem })[], { checks, results, refOf, result, flag });
  duplicatesMerged += vocab.merged;

  // Lifecycle first, then the vocabularies, then the templates (the build order is only that a milestone needs the templates' names).
  const rank: Record<ConfigItemResult['group'], number> = { phase: 0, milestone: 0, decision: 1, finding: 1, response: 1, rating: 1, template: 2, section: 2 };
  results.sort((a, b) => rank[a.group] - rank[b.group]);

  return { lifecycle: life.out, decision: vocab.decision, finding: vocab.finding, response: vocab.response, rating: vocab.rating, templates: templates.built, results, checks, duplicatesMerged };
}

interface Shared {
  checks: Map<string, ConfigItemCheck>;
  results: ConfigItemResult[];
  refOf: (r: RawConfigItem) => ConfigRef;
  result: (r: RawConfigItem, o: Pick<ConfigItemResult, 'group' | 'ref' | 'label' | 'detail'> & Partial<ConfigItemResult>) => ConfigItemResult;
  flag: (r: RawConfigItem, group: ConfigItemResult['group'], label: string, detail: string | null, extra?: string[]) => void;
}

// ---- Lifecycle ------------------------------------------------------------------------------------------------------

type PhaseType = (typeof PHASE_TYPES)[number];
const BOTH_KINDS: ('initial' | 'reaffirmation')[] = ['initial', 'reaffirmation'];
interface PhaseAcc { type: PhaseType; name: string; assumed: boolean; appliesTo: ('initial' | 'reaffirmation')[] | null; raw: RawConfigItem | null; seq: number; milestones: MilestoneAcc[] }
interface MilestoneAcc { raw: RawConfigItem & { item: LifecycleItem }; reasons: string[] }

function buildLifecycle(
  all: (RawConfigItem & { item: LifecycleItem })[],
  s: Shared & { docs: ReadonlyMap<string, ConfigDoc>; textFound: (t: string | null | undefined, r: RawConfigItem) => boolean; templateNames: { key: string; name: string }[] },
): { out: ConfigBuild['lifecycle']; merged: number } {
  const { checks } = s;
  const phaseItems = all.filter((r) => r.item.kind === 'phase');
  const stepItems = all.filter((r) => r.item.kind === 'milestone');
  const phaseDedupe = dedupe(phaseItems, (r) => `${r.item.phase_type ?? ''}\u0000${norm(r.item.name)}`, checks);
  const stepDedupe = dedupe(stepItems, (r) => `${r.item.phase_type ?? ''}\u0000${norm(r.item.name)}`, checks);
  const merged = phaseDedupe.merged + stepDedupe.merged;

  const phases: PhaseAcc[] = [];
  const byTemp = new Map<string, PhaseAcc>();
  for (const r of phaseDedupe.kept) {
    const c = checks.get(r.id)!;
    const type = r.item.phase_type;
    if (!sound(c)) { s.flag(r, 'phase', r.item.name, type ?? null); continue; }
    if (!type) { s.flag(r, 'phase', r.item.name, null, ['phase_missing']); continue; }
    const acc: PhaseAcc = { type, name: r.item.name.trim(), assumed: false, appliesTo: r.item.applies_to?.length ? uniq(r.item.applies_to) : null, raw: r, seq: r.seq, milestones: [] };
    phases.push(acc);
    byTemp.set(`${r.window}:${r.item.temp_id}`, acc);
  }
  const firstOfType = (t: PhaseType) => phases.find((p) => p.type === t);
  const implicit = (t: PhaseType, at: RawConfigItem) => {
    const p: PhaseAcc = { type: t, name: PHASE_NAME[t], assumed: true, appliesTo: null, raw: null, seq: at.seq, milestones: [] };
    phases.push(p);
    return p;
  };

  for (const r of stepDedupe.kept) {
    const c = checks.get(r.id)!;
    if (!sound(c)) { s.flag(r, 'milestone', r.item.name, r.item.milestone_type ?? null); continue; }
    const phase = byTemp.get(`${r.window}:${r.item.phase_temp_id ?? ''}`)
      ?? (r.item.phase_type ? firstOfType(r.item.phase_type) ?? implicit(r.item.phase_type, r) : null);
    if (!phase) { s.flag(r, 'milestone', r.item.name, r.item.milestone_type ?? null, ['phase_missing']); continue; }
    phase.milestones.push({ raw: r, reasons: [] });
  }

  const order = (t: PhaseType) => PHASE_TYPES.indexOf(t);
  phases.sort((a, b) => order(a.type) - order(b.type) || a.seq - b.seq);

  const usedKeys = new Set<string>();
  const refs: Record<string, ConfigRef> = {};
  const outPhases: Lifecycle['phases'] = [];
  let ordinal = 0;
  for (const p of phases) {
    const milestones: Lifecycle['phases'][number]['milestones'] = [];
    const phaseResultIdx = s.results.length;
    for (const m of p.milestones) {
      const r = m.raw;
      const it = r.item;
      const c = checks.get(r.id)!;
      ordinal++;
      const reasons: string[] = reasonsOf(c).filter((x) => x === 'low_confidence');
      const key = uniqueKey(slug(it.name) || `${p.type}_${ordinal}`, usedKeys);
      const type = it.milestone_type ?? (reasons.push('type_assumed'), 'task' as const);
      const name = it.name.trim();
      const description = it.text?.trim() && norm(it.text) !== norm(name) ? (s.textFound(it.text, r) ? it.text.trim() : (reasons.push('description_not_in_source'), undefined)) : undefined;
      const pieces: string[] = [];
      for (const t of [it.due_text, it.repeat_text]) {
        if (!t?.trim()) continue;
        if (s.textFound(t, r)) pieces.push(t.trim()); else reasons.push('due_text_not_in_source');
      }
      const dueText = uniq(pieces).join('; ') || undefined;
      if (dueText) reasons.push('due_pending');
      const deliverable = it.deliverable_name?.trim() ? matchTemplate(it.deliverable_name, s.templateNames) : undefined;
      if (it.deliverable_name?.trim() && !deliverable) reasons.push('deliverable_not_matched');
      // A milestone that applies to fewer kinds of engagement than its phase says so itself.
      const phaseKinds = p.appliesTo ?? BOTH_KINDS;
      const own = it.applies_to?.length ? uniq(it.applies_to) : undefined;
      const narrowed = own && !(own.length === phaseKinds.length && own.every((k) => phaseKinds.includes(k))) ? own : undefined;
      const ref = s.refOf(r);
      milestones.push({
        key, name, type, ...(description ? { description } : {}), ...(deliverable ? { deliverable: { report_template_key: deliverable } } : {}),
        due: null, ...(narrowed ? { applies_to: narrowed } : {}), required: it.required ?? true, source_ref: { doc: ref.document, page: ref.page },
        ...(dueText ? { due_text: dueText, due_pending: true } : {}),
      });
      refs[key] = ref;
      s.results.push(s.result(r, { group: 'milestone', ref: key, label: name, detail: `${type}${it.required === false ? ', optional' : ''}`, reasons: wordsOf(reasons), dueText: dueText ?? null, under: p.name }));
    }
    outPhases.push({ type: p.type, name: p.name, applies_to: p.appliesTo ?? BOTH_KINDS, milestones });
    if (p.raw) {
      const pc = checks.get(p.raw.id)!;
      refs[`phase:${p.name}`] = s.refOf(p.raw);
      s.results.splice(phaseResultIdx, 0, s.result(p.raw, { group: 'phase', ref: `phase:${p.name}`, label: p.name, detail: p.type, reasons: wordsOf(reasonsOf(pc).filter((x) => x === 'low_confidence')) }));
    } else if (p.milestones[0]) {
      const r0 = p.milestones[0].raw;
      s.results.splice(phaseResultIdx, 0, s.result(r0, { group: 'phase', ref: null, label: p.name, detail: p.type, reasons: wordsOf(['phase_name_assumed']) }));
    }
  }

  if (!outPhases.length) return { out: { value: null, refs: {} }, merged };
  const parsed = LifecycleTemplateSchema.safeParse({ phases: outPhases });
  if (!parsed.success) {
    // The schema refused it as a whole: nothing of the lifecycle is written; each item says why.
    const why = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).slice(0, 3).join('; ');
    for (const res of s.results) if (res.group === 'phase' || res.group === 'milestone') { res.status = 'flagged'; res.reasons = [...res.reasons, `the lifecycle did not pass validation (${why})`]; }
    return { out: { value: null, refs: {} }, merged };
  }
  return { out: { value: parsed.data, refs }, merged };
}

/** The key of the template a milestone's deliverable names: the same name, or one that contains the other (6+ letters). */
function matchTemplate(name: string, templates: { key: string; name: string }[]): string | undefined {
  const n = norm(name);
  if (!n) return undefined;
  const exact = templates.filter((t) => norm(t.name) === n);
  if (exact.length === 1) return exact[0]!.key;
  const near = templates.filter((t) => { const m = norm(t.name); return m.length >= 6 && n.length >= 6 && (m.includes(n) || n.includes(m)); });
  return near.length === 1 ? near[0]!.key : undefined;
}

// ---- Vocabularies ---------------------------------------------------------------------------------------------------

function buildVocab(all: (RawConfigItem & { item: VocabItem })[], s: Shared): {
  decision: ConfigBuild['decision']; finding: ConfigBuild['finding']; response: ConfigBuild['response']; rating: ConfigBuild['rating']; merged: number;
} {
  const { checks } = s;
  const d = dedupe(all, (r) => `${r.item.kind}\u0000${norm(r.item.label)}`, checks);
  const decision: ConfigBuild['decision'] = { value: [], refs: {} };
  const finding: ConfigBuild['finding'] = { value: [], refs: {} };
  const response: ConfigBuild['response'] = { value: [], refs: {} };
  let rating: ConfigBuild['rating'] = { value: null, ref: null };
  const used = { decision: new Set<string>(), finding: new Set<string>(), response: new Set<string>() };
  const n = { decision: 0, finding: 0, response: 0 };

  for (const r of d.kept) {
    const it = r.item;
    const c = checks.get(r.id)!;
    const low: string[] = reasonsOf(c).filter((x) => x === 'low_confidence');
    const label = it.label.trim();
    if (it.kind === 'rating_method') {
      if (!sound(c)) { s.flag(r, 'rating', label, null); continue; }
      if (rating.value) continue; // at most one
      const cand = RatingMethodSchema.safeParse({ scale: it.scale ?? [], labels: (it.labels ?? []).map((x) => x.trim()), rated_level: it.rated_level?.trim() ?? '', aggregate: it.aggregate?.trim() ?? '' });
      if (!cand.success || !cand.data) { s.flag(r, 'rating', label, null, ['rating_incomplete']); continue; }
      rating = { value: cand.data, ref: s.refOf(r) };
      s.results.push(s.result(r, { group: 'rating', ref: 'rating_method', label, detail: `${cand.data.scale.length} levels`, reasons: wordsOf(low) }));
      continue;
    }
    const group = it.kind === 'decision' ? 'decision' : it.kind === 'finding_severity' ? 'finding' : 'response';
    const detailOf = () => (it.kind === 'decision' ? it.outcome ?? null : it.kind === 'finding_severity' ? (it.requires_action === true ? 'requires action' : it.requires_action === false ? 'no action' : null) : it.reply_kind ?? null);
    if (!sound(c)) { s.flag(r, group, label, detailOf()); continue; }
    if (it.kind === 'decision') {
      if (!it.outcome) { s.flag(r, 'decision', label, null, ['outcome_not_stated']); continue; }
      const code = deriveCode(it.printed_code, label, 'decision', ++n.decision, used.decision);
      const entry = {
        code, label, outcome: it.outcome,
        ...(it.term_years && it.term_years > 0 ? { term_years: it.term_years } : {}),
        ...(it.term_options?.length && it.term_options.every((y) => y > 0) ? { term_options: uniq(it.term_options) } : {}),
      };
      const ok = DecisionVocabSchema.safeParse([entry]);
      if (!ok.success) { used.decision.delete(code.toLowerCase()); s.flag(r, 'decision', label, it.outcome, [ok.error.issues[0]?.message ?? 'refused by the schema']); continue; }
      decision.value.push(ok.data[0]!);
      decision.refs[code] = s.refOf(r);
      s.results.push(s.result(r, { group: 'decision', ref: code, label, detail: it.outcome, reasons: wordsOf(low) }));
    } else if (it.kind === 'finding_severity') {
      if (typeof it.requires_action !== 'boolean') { s.flag(r, 'finding', label, null, ['requires_action_not_stated']); continue; }
      const code = deriveCode(it.printed_code, label, 'finding', ++n.finding, used.finding);
      const ok = FindingVocabSchema.safeParse([{ code, label, requires_action: it.requires_action }]);
      if (!ok.success) { used.finding.delete(code.toLowerCase()); s.flag(r, 'finding', label, null, [ok.error.issues[0]?.message ?? 'refused by the schema']); continue; }
      finding.value.push(ok.data[0]!);
      finding.refs[code] = s.refOf(r);
      s.results.push(s.result(r, { group: 'finding', ref: code, label, detail: it.requires_action ? 'requires action' : 'no action', reasons: wordsOf(low) }));
    } else {
      const code = deriveCode(it.printed_code, label, 'response', ++n.response, used.response);
      const reasons = [...low];
      // A reply that is a report needs a report template to be built from, which the document cannot name by key.
      const replyKind = it.reply_kind === 'report' || it.reply_kind === 'report_and_revision' ? (reasons.push('reply_kind_needs_template'), undefined) : it.reply_kind ?? undefined;
      const entry = {
        code, label,
        ...(typeof it.reply_required === 'boolean' ? { reply_required: it.reply_required } : {}),
        ...(it.reply_window_days && it.reply_window_days > 0 ? { reply_window_days: it.reply_window_days } : {}),
        ...(replyKind ? { reply_kind: replyKind } : {}),
        ...(typeof it.is_decision === 'boolean' ? { is_decision: it.is_decision } : {}),
      };
      const ok = ResponseVocabSchema.safeParse([entry]);
      if (!ok.success) { used.response.delete(code.toLowerCase()); s.flag(r, 'response', label, null, [ok.error.issues[0]?.message ?? 'refused by the schema']); continue; }
      response.value.push(ok.data[0]!);
      response.refs[code] = s.refOf(r);
      s.results.push(s.result(r, { group: 'response', ref: code, label, detail: replyKind ?? null, reasons: wordsOf(reasons) }));
    }
  }
  return { decision, finding, response, rating, merged: d.merged };
}

// ---- Report templates -------------------------------------------------------------------------------------------------

function buildTemplates(
  all: (RawConfigItem & { item: TemplateItem })[],
  s: Shared & {
    docs: ReadonlyMap<string, ConfigDoc>; pages: ReadonlyMap<string, PageTexts>; templateHints: ReadonlyMap<string, TemplateHint>;
    textFound: (t: string | null | undefined, r: RawConfigItem) => boolean;
  },
): { built: BuiltTemplate[]; merged: number } {
  const { checks } = s;
  const byDoc = new Map<string, (RawConfigItem & { item: TemplateItem })[]>();
  for (const r of all) byDoc.set(r.documentId, [...(byDoc.get(r.documentId) ?? []), r]);
  const built: BuiltTemplate[] = [];
  const usedKeys = new Set<string>();
  let merged = 0;
  let docNo = 0;

  for (const [documentId, list] of [...byDoc.entries()].sort((a, b) => (a[1][0]?.seq ?? 0) - (b[1][0]?.seq ?? 0))) {
    docNo++;
    const doc = s.docs.get(documentId) ?? { id: documentId, title: 'source', language: 'en', role: 'other' };
    const hint = s.templateHints.get(documentId);
    const d = dedupe(list, (r) => `${norm(r.item.number ?? '')}\u0000${norm(r.item.title)}`, checks);
    merged += d.merged;
    const name = hint?.name?.trim() || doc.title;

    // Sound sections only; the rest are flagged.
    const sections = d.kept.filter((r) => {
      if (sound(checks.get(r.id)!)) return true;
      s.flag(r, 'section', r.item.title, r.item.block_type, []);
      return false;
    });
    const byTemp = new Map(sections.map((r) => [`${r.window}:${r.item.temp_id}`, r]));
    const byNumber = new Map<string, RawConfigItem & { item: TemplateItem }>();
    for (const r of sections) if (r.item.number?.trim()) byNumber.set(norm(r.item.number), r);

    // Keys: the printed number; unique within the template.
    const keys = new Map<RawConfigItem, string>();
    const used = new Set<string>();
    sections.forEach((r, i) => keys.set(r, uniqueKey(sectionKeyOf(r.item.number) || `S${i + 1}`, used)));

    // Columns that make a table valid; a table with none is flagged and left out (its children move up).
    const dropped = new Set<RawConfigItem>();
    const nodes = new Map<RawConfigItem, SectionTemplate>();
    const reasonsOfSection = new Map<RawConfigItem, string[]>();
    for (const r of sections) {
      const it = r.item;
      const reasons: string[] = reasonsOf(checks.get(r.id)!).filter((x) => x === 'low_confidence');
      const node: SectionTemplate = { key: keys.get(r)!, title: it.title.trim(), block_type: it.block_type };
      if (it.prompt?.trim()) { if (s.textFound(it.prompt, r)) node.prompt = it.prompt.trim(); else reasons.push('prompt_not_in_source'); }
      if (it.word_limit && it.word_limit > 0) node.word_limit = it.word_limit;
      if (it.columns?.length) {
        const colKeys = new Set<string>();
        node.columns = it.columns.map((col, ci) => {
          const base = { key: uniqueKey(slug(col.label) || `c${ci + 1}`, colKeys), label: col.label.trim() };
          if (col.type === 'enum') {
            if (col.options?.length) return { ...base, type: 'enum' as const, options: col.options.map((o) => o.trim()) };
            reasons.push('enum_options_missing');
            return { ...base, type: 'text' as const };
          }
          return { ...base, type: col.type };
        });
      }
      if (it.block_type === 'data_table' && !node.columns?.length) {
        dropped.add(r);
        s.flag(r, 'section', it.title, it.block_type, ['columns_missing']);
        continue;
      }
      nodes.set(r, node);
      reasonsOfSection.set(r, reasons);
    }

    // Nesting: by temp id in the window, else by the parent's printed number; a missing parent puts it at the top level.
    const parentOf = (r: RawConfigItem & { item: TemplateItem }): (RawConfigItem & { item: TemplateItem }) | null => {
      const direct = r.item.parent_temp_id ? byTemp.get(`${r.window}:${r.item.parent_temp_id}`) : undefined;
      const viaNumber = r.item.parent_number?.trim() ? byNumber.get(norm(r.item.parent_number)) : undefined;
      let p = direct ?? viaNumber ?? null;
      for (let guard = 0; p && dropped.has(p) && guard < 20; guard++) p = parentOf(p);
      return p && p !== r ? p : null;
    };
    const roots: SectionTemplate[] = [];
    const sectionRefs: Record<string, ConfigRef> = {};
    const placed: [RawConfigItem & { item: TemplateItem }, SectionTemplate][] = [];
    for (const r of sections) {
      const node = nodes.get(r);
      if (!node) continue;
      const p = parentOf(r);
      const wantedParent = (r.item.parent_temp_id && !byTemp.has(`${r.window}:${r.item.parent_temp_id}`)) || (r.item.parent_number?.trim() && !byNumber.has(norm(r.item.parent_number)));
      if (wantedParent && !p) reasonsOfSection.get(r)!.push('parent_not_found');
      // A cycle (a -> b -> a) is cut at the first repeat.
      let cyc = false;
      for (let at: (RawConfigItem & { item: TemplateItem }) | null = p, guard = 0; at && guard < 50; at = parentOf(at), guard++) if (at === r) { cyc = true; break; }
      const parent = cyc ? null : p;
      const pn = parent ? nodes.get(parent) : undefined;
      if (pn) (pn.children ??= []).push(node); else roots.push(node);
      placed.push([r, node]);
      sectionRefs[node.key] = s.refOf(r);
    }
    if (!roots.length) {
      s.results.push(s.result(list[0]!, { group: 'template', ref: null, label: name, detail: 'no sections', status: 'flagged', reasons: wordsOf(['no_sections']) }));
      continue;
    }
    const requiresAttestation = placed.some(([, n]) => n.block_type === 'attestation');
    const key = uniqueKey(slug(name) || `template_${docNo}`, usedKeys);
    const candidate = {
      key, name, kind: hint?.kind ?? 'other', language: doc.language || 'en', structure: { sections: roots }, word_limit: null, requires_attestation: requiresAttestation,
    };
    const ok = ReportTemplateConfigSchema.safeParse(candidate);
    if (!ok.success) {
      usedKeys.delete(key.toLowerCase());
      const why = ok.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      s.results.push(s.result(list[0]!, { group: 'template', ref: null, label: name, detail: `${placed.length} sections`, status: 'flagged', reasons: [`refused by the template schema (${why})`] }));
      for (const [r, n] of placed) s.results.push(s.result(r, { group: 'section', ref: n.key, label: n.title, detail: n.block_type, status: 'flagged', reasons: ['the template it belongs to was refused'], under: name }));
      continue;
    }
    // Internal consistency of the tree itself (unique keys, attestation section) is the cross-check the editors use.
    const issues = checkFrameworkConfig({
      level_labels: ['x'], lifecycle_template: { phases: [{ type: 'self_study', name: 'x', applies_to: ['initial'], milestones: [] }] }, decision_vocab: [], finding_vocab: [], response_vocab: [],
      report_templates: [ok.data],
    }).filter((i) => i.path.startsWith('report_templates'));
    if (issues.length) {
      usedKeys.delete(key.toLowerCase());
      s.results.push(s.result(list[0]!, { group: 'template', ref: null, label: name, detail: `${placed.length} sections`, status: 'flagged', reasons: issues.map((i) => i.message) }));
      continue;
    }
    const first = placed[0]![0];
    const templateRef = s.refOf(first);
    s.results.push(s.result(first, { group: 'template', ref: key, label: name, detail: `${hint?.kind ?? 'other'}, ${placed.length} ${placed.length === 1 ? 'section' : 'sections'}` }));
    for (const [r, n] of placed) {
      s.results.push(s.result(r, { group: 'section', ref: n.key, label: n.title, detail: n.block_type, reasons: wordsOf(reasonsOfSection.get(r) ?? []), under: name }));
    }
    built.push({ ...ok.data, kind: ok.data.kind, structure: ok.data.structure as { sections: SectionTemplate[] }, documentId, source: templateRef, sectionRefs });
  }
  return { built, merged };
}

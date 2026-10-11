import { and, asc, eq, inArray } from 'drizzle-orm';
import { accreditor, framework, frameworkVersion, reportTemplate, requirement, requirementNote, sourceDocument, sourcePage } from '@ams/db';
import { checkFrameworkConfig, FRAMEWORK_EXPORT_FORMAT, FRAMEWORK_EXPORT_VERSION, FrameworkExportSchema, type FrameworkExport } from '@ams/shared';
import { createHash } from 'node:crypto';
import type { Ctx } from '../ctx.js';
import { ConflictError, ValidationError } from '../ctx.js';
import { guardIntegrity } from './errors.js';
import { getVersion, require_ } from './common.js';
import { quoteInText } from './quote.js';

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Exports one framework version as a single JSON document (PRD 7.7). Deterministic: the same version always yields the
 * same bytes, so an export-import-export round trip can be compared.
 */
export async function exportVersion(ctx: Ctx, versionId: string): Promise<FrameworkExport> {
  await require_(ctx, 'framework:read');
  const v = await getVersion(ctx, versionId);
  const [fw] = await ctx.tx.select().from(framework).where(eq(framework.id, v.frameworkId));
  const [acc] = await ctx.tx.select().from(accreditor).where(eq(accreditor.id, fw!.accreditorId));

  const docs = await ctx.tx.select().from(sourceDocument).where(eq(sourceDocument.frameworkVersionId, versionId));
  docs.sort((a, b) => byText(a.title, b.title) || byText(a.sha256, b.sha256));
  const docRef = new Map(docs.map((d, i) => [d.id, `doc-${i + 1}`]));
  const pages = docs.length ? await ctx.tx.select().from(sourcePage).where(inArray(sourcePage.sourceDocumentId, docs.map((d) => d.id))).orderBy(asc(sourcePage.pageNo)) : [];

  const reqs = await ctx.tx.select().from(requirement).where(eq(requirement.frameworkVersionId, versionId));
  const codeOf = new Map(reqs.map((r) => [r.id, r.code]));
  const notes = reqs.length ? await ctx.tx.select().from(requirementNote).where(inArray(requirementNote.requirementId, reqs.map((r) => r.id))) : [];
  const templates = await ctx.tx.select().from(reportTemplate).where(eq(reportTemplate.frameworkVersionId, versionId)).orderBy(asc(reportTemplate.key));

  const source = (s: { sourceDocumentId: string | null; sourcePage: number | null; sourceQuote: string | null }) =>
    s.sourceDocumentId && s.sourcePage && s.sourceQuote && docRef.has(s.sourceDocumentId)
      ? { document: docRef.get(s.sourceDocumentId)!, page: s.sourcePage, quote: s.sourceQuote }
      : null;

  // Tree order: parents first; siblings by display order then code.
  const children = new Map<string | null, typeof reqs>();
  for (const r of reqs) children.set(r.parentId ?? null, [...(children.get(r.parentId ?? null) ?? []), r]);
  for (const list of children.values()) list.sort((a, b) => a.displayOrder - b.displayOrder || byText(a.code, b.code));
  const ordered: typeof reqs = [];
  const walk = (p: string | null) => { for (const r of children.get(p) ?? []) { ordered.push(r); walk(r.id); } };
  walk(null);

  const out: FrameworkExport = {
    format: FRAMEWORK_EXPORT_FORMAT,
    format_version: FRAMEWORK_EXPORT_VERSION,
    accreditor: { name: acc!.name, short_name: acc!.shortName, type: acc!.type, country: acc!.country, website: acc!.website },
    framework: { name: fw!.name, commission: fw!.commission, scope: fw!.scope, description: fw!.description },
    version: { edition: v.edition, effective_from: v.effectiveFrom, effective_to: v.effectiveTo, change_summary: v.changeSummary },
    config: {
      level_labels: v.levelLabels as string[],
      lifecycle_template: v.lifecycleTemplate as FrameworkExport['config']['lifecycle_template'],
      decision_vocab: v.decisionVocab as FrameworkExport['config']['decision_vocab'],
      finding_vocab: v.findingVocab as FrameworkExport['config']['finding_vocab'],
      response_vocab: v.responseVocab as FrameworkExport['config']['response_vocab'],
      ...(v.ratingMethod ? { rating_method: v.ratingMethod as NonNullable<FrameworkExport['config']['rating_method']> } : {}),
      report_templates: templates.map((t) => ({
        key: t.key, name: t.name, kind: t.kind, language: t.language, structure: t.structure as FrameworkExport['config']['report_templates'][number]['structure'],
        word_limit: t.wordLimit, requires_attestation: t.requiresAttestation,
      })),
    },
    source_documents: docs.map((d) => ({
      ref: docRef.get(d.id)!, title: d.title, role: d.role, authority: d.authority, language: d.language, sha256: d.sha256,
      pages: pages.filter((p) => p.sourceDocumentId === d.id && p.text.trim()).map((p) => ({ page_no: p.pageNo, text: p.text, method: p.method })),
    })),
    requirements: ordered.map((r) => ({
      code: r.code,
      parent_code: r.parentId ? codeOf.get(r.parentId) ?? null : null,
      level_label: r.levelLabel, title: r.title, official_text: r.officialText, language: r.language, translation_en: r.translationEn,
      is_assessable: r.isAssessable, applies_when: (r.appliesWhen ?? null) as FrameworkExport['requirements'][number]['applies_when'],
      display_order: r.displayOrder, weight: r.weight === null ? null : Number(r.weight), source: source(r),
      notes: notes.filter((n) => n.requirementId === r.id)
        .sort((a, b) => byText(a.type, b.type) || byText(a.authority, b.authority) || byText(a.text, b.text))
        .map((n) => ({ type: n.type, text: n.text, authority: n.authority, norm: (n.norm ?? null) as Record<string, unknown> | null, source: source(n) })),
    })),
  };
  return out;
}

export interface ImportOptions {
  /** Edition to create; defaults to the file's. A new draft is always created, never an existing version changed. */
  edition?: string;
}

/**
 * Imports a framework file as a new draft version. Everything is validated first and every problem is reported
 * together. Quote verification is recomputed from the imported page text; flags in the file are never trusted.
 */
/**
 * A requirement whose wording was put in its title, with no description, is stored the way the rest are: the wording as
 * the description and the code as the title (a sentence, or more than 60 characters, is wording, not a title). Migration
 * 0034 applied the same rule to existing drafts.
 */
export function splitTitleAndText(code: string, title: string, text: string | null | undefined): { title: string; officialText: string | null } {
  const t = title.trim();
  if ((text ?? '').trim() || !(t.length > 60 || /[.!?\u061F]\s*$/.test(t))) return { title, officialText: text ?? null };
  return { title: code, officialText: t };
}

export async function importVersion(ctx: Ctx, raw: unknown, options: ImportOptions = {}) {
  await require_(ctx, 'framework:write');

  const parsed = FrameworkExportSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError('not a valid framework file', parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  }
  const file = parsed.data;
  const problems: { path: string; message: string }[] = checkFrameworkConfig(file.config).map((i) => ({ path: `config.${i.path}`, message: i.message }));

  const codes = new Set<string>();
  for (const r of file.requirements) {
    if (codes.has(r.code)) problems.push({ path: 'requirements', message: `duplicate code ${r.code}` });
    codes.add(r.code);
  }
  for (const r of file.requirements) {
    if (r.parent_code && !codes.has(r.parent_code)) problems.push({ path: `requirements.${r.code}`, message: `unknown parent ${r.parent_code}` });
    if (r.parent_code === r.code) problems.push({ path: `requirements.${r.code}`, message: 'a requirement cannot be its own parent' });
  }
  const pageText = new Map<string, string>(); // `${ref}:${page}` -> text
  for (const d of file.source_documents) for (const p of d.pages) pageText.set(`${d.ref}:${p.page_no}`, p.text);
  const refs = new Set(file.source_documents.map((d) => d.ref));
  if (refs.size !== file.source_documents.length) problems.push({ path: 'source_documents', message: 'document refs must be unique' });
  const sources = file.requirements.flatMap((r) => [r.source, ...r.notes.map((n) => n.source)].filter((s): s is NonNullable<typeof s> => s !== null));
  for (const s of sources) if (!refs.has(s.document)) problems.push({ path: 'requirements', message: `unknown source document ${s.document}` });
  for (const r of file.requirements) {
    for (const n of r.notes) {
      if (n.authority === 'required' && !n.source) problems.push({ path: `requirements.${r.code}`, message: 'a required note must cite its source' });
    }
  }

  // Parents before children, and no cycles.
  const byCode = new Map(file.requirements.map((r) => [r.code, r]));
  const order: typeof file.requirements = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (code: string): void => {
    if (state.get(code) === 'done') return;
    if (state.get(code) === 'visiting') { problems.push({ path: `requirements.${code}`, message: 'parent cycle' }); return; }
    state.set(code, 'visiting');
    const r = byCode.get(code)!;
    if (r.parent_code && byCode.has(r.parent_code)) visit(r.parent_code);
    state.set(code, 'done');
    order.push(r);
  };
  for (const r of file.requirements) visit(r.code);
  if (problems.length) throw new ValidationError('the framework file has problems', problems);

  const [existingAcc] = await ctx.tx.select().from(accreditor).where(eq(accreditor.shortName, file.accreditor.short_name));
  const acc = existingAcc ?? (await ctx.tx.insert(accreditor).values({
    institutionId: ctx.caller.institutionId, name: file.accreditor.name, shortName: file.accreditor.short_name, type: file.accreditor.type,
    country: file.accreditor.country, website: file.accreditor.website,
  }).returning())[0]!;
  const [existingFw] = await ctx.tx.select().from(framework).where(and(eq(framework.accreditorId, acc.id), eq(framework.name, file.framework.name)));
  const fw = existingFw ?? (await ctx.tx.insert(framework).values({
    institutionId: ctx.caller.institutionId, accreditorId: acc.id, name: file.framework.name, commission: file.framework.commission,
    scope: file.framework.scope, description: file.framework.description,
  }).returning())[0]!;

  const edition = options.edition ?? file.version.edition;
  const [clash] = await ctx.tx.select({ id: frameworkVersion.id }).from(frameworkVersion).where(and(eq(frameworkVersion.frameworkId, fw.id), eq(frameworkVersion.edition, edition)));
  if (clash) throw new ConflictError(`edition ${edition} already exists for ${fw.name}; import under another edition`);

  // An imported standard follows the rules of an AI draft (DEC-022): everything pending, nothing approved line by line;
  // publishing the version is the review.
  const approval = { reviewStatus: 'pending' as const, reviewedBy: null, reviewedAt: null };

  const [version] = await guardIntegrity(() => ctx.tx.insert(frameworkVersion).values({
    institutionId: ctx.caller.institutionId, frameworkId: fw.id, edition,
    effectiveFrom: file.version.effective_from, effectiveTo: file.version.effective_to, changeSummary: file.version.change_summary,
    levelLabels: file.config.level_labels, lifecycleTemplate: file.config.lifecycle_template, decisionVocab: file.config.decision_vocab,
    findingVocab: file.config.finding_vocab, responseVocab: file.config.response_vocab, ratingMethod: file.config.rating_method ?? null,
  }).returning());
  const v = version!;

  const docId = new Map<string, string>();
  for (const d of file.source_documents) {
    const sha = d.sha256 ?? createHash('sha256').update(d.pages.map((p) => p.text).join('\n')).digest('hex');
    const [row] = await ctx.tx.insert(sourceDocument).values({
      institutionId: ctx.caller.institutionId, frameworkVersionId: v.id, title: d.title, role: d.role, authority: d.authority, language: d.language,
      filePath: `imported/${d.ref}`, sha256: sha, pageCount: d.pages.length || null, textStatus: d.pages.length ? 'extracted' : 'pending',
    }).returning();
    docId.set(d.ref, row!.id);
    for (const p of d.pages) {
      await ctx.tx.insert(sourcePage).values({ institutionId: ctx.caller.institutionId, sourceDocumentId: row!.id, pageNo: p.page_no, text: p.text, method: p.method });
    }
  }
  const prov = (s: { document: string; page: number; quote: string } | null) => {
    if (!s) return { sourceDocumentId: null, sourcePage: null, sourceQuote: null, quoteVerified: false };
    const text = pageText.get(`${s.document}:${s.page}`);
    return { sourceDocumentId: docId.get(s.document)!, sourcePage: s.page, sourceQuote: s.quote, quoteVerified: text !== undefined && quoteInText(s.quote, text) };
  };

  const idOf = new Map<string, string>();
  for (const r of order) {
    const { title, officialText } = splitTitleAndText(r.code, r.title, r.official_text);
    const [row] = await guardIntegrity(() => ctx.tx.insert(requirement).values({
      institutionId: ctx.caller.institutionId, frameworkVersionId: v.id, parentId: r.parent_code ? idOf.get(r.parent_code)! : null,
      code: r.code, levelLabel: r.level_label, title, officialText, language: r.language, translationEn: r.translation_en,
      isAssessable: r.is_assessable, appliesWhen: r.applies_when, displayOrder: r.display_order, weight: r.weight === null ? null : String(r.weight),
      origin: 'import', ...prov(r.source), ...approval,
    }).returning());
    idOf.set(r.code, row!.id);
    for (const n of r.notes) {
      await guardIntegrity(() => ctx.tx.insert(requirementNote).values({
        institutionId: ctx.caller.institutionId, requirementId: row!.id, type: n.type, text: n.text, authority: n.authority, norm: n.norm,
        origin: 'import', ...prov(n.source), ...approval,
      }));
    }
  }
  for (const t of file.config.report_templates) {
    await guardIntegrity(() => ctx.tx.insert(reportTemplate).values({
      institutionId: ctx.caller.institutionId, frameworkVersionId: v.id, key: t.key, name: t.name, kind: t.kind, language: t.language,
      structure: t.structure, wordLimit: t.word_limit ?? null, requiresAttestation: t.requires_attestation, origin: 'import', ...approval,
    }));
  }
  return { version: v, counts: { requirements: order.length, documents: file.source_documents.length, templates: file.config.report_templates.length } };
}

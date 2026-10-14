// The report of an import run (TASK-075): built on demand from what is stored, never from a model. Counts of what was read, found
// and checked, with the reasons a row deserves a look. Wording rules (DEC-005): no score, no verdict, no prediction.
import { and, asc, eq } from 'drizzle-orm';
import { importPage, importProposal, sourcePage } from '@ams/db';
import { IMPORT_REPORT_VERSION, type ImportReport } from '@ams/shared';
import type { Ctx } from '../ctx.js';
import { LOW_CONFIDENCE } from '../framework/analysis/merge.js';
import { documentReadState } from './documents.js';
import { listImportApplies, toProposalDto } from './proposals.js';
import { loadRunForRead, toRunDtos } from './runs.js';
import { describeScope, getDocScope } from './scopes.js';

interface StoredReport {
  readErrors?: Record<string, string>;
  runtime?: { model: string; role: 'analysis' | 'reading' };
  stoppedBy?: 'budget' | 'cancelled' | 'error';
  stoppedMessage?: string;
}

const NOT_FOUND = 'The quote was not found on the page it cites.';

export async function getImportReport(ctx: Ctx, runId: string): Promise<ImportReport> {
  const run = await loadRunForRead(ctx, runId);
  const stored = (run.report ?? {}) as StoredReport;
  const dto = (await toRunDtos(ctx, [run]))[0]!;
  const source = getDocScope(run.scopeKind).storage === 'source';

  const documents: ImportReport['documents'] = [];
  for (const id of run.documentIds) {
    const state = await documentReadState(ctx, run.scopeKind, id);
    const pages: { method: string; needsOcr: boolean; warnings: string[] }[] = source
      ? (await ctx.tx.select({ method: sourcePage.method, needsOcr: sourcePage.needsOcr }).from(sourcePage).where(eq(sourcePage.sourceDocumentId, id))).map((p) => ({ ...p, warnings: [] }))
      : await ctx.tx.select({ method: importPage.method, needsOcr: importPage.needsOcr, warnings: importPage.warnings }).from(importPage).where(eq(importPage.importDocumentId, id));
    const unreadable = pages.filter((p) => p.needsOcr).length;
    const ocr = pages.filter((p) => !p.needsOcr && p.method === 'ocr').length;
    const warnings = pages.flatMap((p) => p.warnings).slice(0, 5);
    if (stored.readErrors?.[id]) warnings.unshift(stored.readErrors[id]);
    documents.push({
      documentId: id, name: state?.name ?? 'A deleted document', pages: pages.length, pagesNative: pages.length - unreadable - ocr, pagesOcr: ocr, pagesUnreadable: unreadable,
      status: state?.status ?? 'failed', readError: stored.readErrors?.[id] ?? state?.error ?? (state ? null : 'the document was deleted'), warnings,
    });
  }

  const rows = await ctx.tx.select().from(importProposal).where(and(eq(importProposal.runId, runId), eq(importProposal.candidate, false))).orderBy(asc(importProposal.seq));
  const names = new Map(documents.map((d) => [d.documentId, d.name]));
  const flagged: ImportReport['flagged'] = [];
  for (const r of rows) {
    const reasons = [...(r.flags as string[])];
    if (!r.quoteVerified && !reasons.includes(NOT_FOUND)) reasons.push(NOT_FOUND);
    if (!reasons.length) continue;
    const p = toProposalDto(r, names);
    flagged.push({ proposalId: r.id, label: p.label, status: r.status, reasons, documentId: r.documentId, documentName: p.documentName, pageNo: r.pageNo });
  }

  const applies = await listImportApplies(ctx, runId);
  return {
    version: IMPORT_REPORT_VERSION, run: dto, scopeLabel: await describeScope(ctx, run.scopeKind, run.scopeId), documents,
    totals: {
      documents: documents.length, documentsRead: documents.filter((d) => d.status === 'read' || d.status === 'needs_ocr').length, pages: documents.reduce((n, d) => n + d.pages, 0),
      ocrPages: documents.reduce((n, d) => n + d.pagesOcr, 0), unreadablePages: documents.reduce((n, d) => n + d.pagesUnreadable, 0),
    },
    proposals: {
      ...dto.counts, quoteVerified: rows.filter((r) => r.quoteVerified).length, quoteNotFound: rows.filter((r) => !r.quoteVerified).length,
      lowConfidence: rows.filter((r) => r.confidence !== null && r.confidence < LOW_CONFIDENCE).length,
    },
    flagged, usage: dto.usage, models: { model: run.model ?? stored.runtime?.model ?? null, role: stored.runtime?.role ?? null }, promptVersion: run.promptVersion,
    stoppedBy: run.status === 'cancelled' ? 'cancelled' : stored.stoppedBy ?? null, stoppedMessage: run.status === 'cancelled' ? 'Cancelled by a person; what was found before is kept.' : stored.stoppedMessage ?? null,
    applies,
  };
}

/** Plain words for the report's header line: "Programs import: 12 found from 2 documents (14 pages)". */
export function reportHeadline(r: ImportReport): string {
  const found = r.proposals.total;
  return `${r.run.targetLabel} import: ${found} ${found === 1 ? 'item' : 'items'} found in ${r.totals.documents} ${r.totals.documents === 1 ? 'document' : 'documents'} (${r.totals.pages} ${r.totals.pages === 1 ? 'page' : 'pages'})`;
}

// The bookkeeping of the check-and-recover passes (PRD 15, step D). Pure: no database, no AI.
//
// After the extraction, the `gaps` stage runs the gap finder (gaps.ts) over everything proposed so far and reconciles
// what it finds with the gaps already on record; then it either plans one round of narrow questions (the `recover`
// stage asks them, one small job per question group) or stops. A round that adds nothing (no newly verified item and no
// newly confirmed absence), the round limit of Settings -> AI, and the per-run spend limit all stop it.
import type { AnalysisGap } from '@ams/shared';
import type { FoundGap } from './gaps.js';

/** At most this many questions in one model call (they share the same pages). */
export const MAX_QUESTIONS_PER_TASK = 4;
/** At most this many calls per round; gaps beyond it wait for the next round (or stay unresolved). */
export const MAX_TASKS_PER_ROUND = 12;

export type RecoveryStop = 'no_gaps' | 'nothing_to_ask' | 'max_rounds' | 'nothing_new' | 'budget';

export interface RecoveryQuestion {
  /** Short id the model answers with ("q1"). */
  id: string;
  /** The gap it is about. */
  key: string;
  text: string;
  /** Reading order for anything it brings back. */
  anchorSeq: number;
}
export interface RecoveryTask { documentId: string; pages: number[]; questions: RecoveryQuestion[] }
export interface RecoveryRound { round: number; open: number; tasks: number; questions: number; itemsLogged: number; confirmedAbsent: number }
export interface RecoveryState {
  /** Snapshot of Settings -> AI at the first gaps stage, so a change mid-run does not move the goal posts. */
  maxRounds: number;
  /** The round being asked (1-based); 0 before the first. */
  round: number;
  tasks: RecoveryTask[];
  rounds: RecoveryRound[];
  /** Verified items plus confirmed absences at the last gaps stage: a round that does not raise it found nothing new. */
  progressMark: number;
  stopped: RecoveryStop | null;
}

/**
 * Merges what the finder sees now with the gaps on record. A gap that is no longer found was recovered (or, for one the
 * model had confirmed absent, stays so); one still found stays open unless confirmed absent (never asked again); new
 * ones are added. `round` is the round whose answers the finder is looking at (0: the extraction only).
 */
export function reconcileGaps(prev: AnalysisGap[], found: FoundGap[], round: number): AnalysisGap[] {
  const now = new Map(found.map((f) => [f.key, f]));
  const out: AnalysisGap[] = [];
  for (const g of prev) {
    const f = now.get(g.key);
    now.delete(g.key);
    if (!f) {
      if (g.status === 'open' || g.status === 'unresolved') out.push({ ...g, status: 'recovered', round });
      else if (g.status !== 'conflict') out.push(g); // a conflict that is gone (a person changed the draft) is dropped
      continue;
    }
    const where = { documentId: f.documentId, page: f.page, detail: f.detail };
    if (g.status === 'confirmed_absent') out.push(g);
    else if (f.kind === 'conflict') out.push({ ...g, ...where, status: 'conflict' });
    else out.push({ ...g, ...where, status: 'open' });
  }
  for (const f of now.values()) {
    out.push({
      key: f.key, kind: f.kind, status: f.kind === 'conflict' ? 'conflict' : 'open', code: f.code, documentId: f.documentId, page: f.page,
      round, attempts: 0, detail: f.detail, reason: null, requirementId: null,
    });
  }
  return out;
}

/** The narrow question for one gap, in words the model is given (the system prompt is recover.v1). */
export function questionFor(f: FoundGap): string {
  const q = (s: string) => `"${s}"`;
  switch (f.kind) {
    case 'numbering_gap':
      return `Is there a requirement coded ${q(f.code!)} on these pages? It would come ${f.detail}. If there is, return it, copied exactly, with its page and quote. If there is not (for example, the numbering skips it), answer found=false and say why.`;
    case 'missing_parent':
      return `The code ${q(f.code!)} is ${f.detail}, but no requirement with that code was found. Is it on these pages? If so, return it, copied exactly, with its page and quote; if not, answer found=false and say why.`;
    case 'unverified_quote':
    case 'low_confidence':
      if (f.item?.kind === 'note') {
        return `Re-cite this note on requirement ${q(f.code!)}, proposed as: ${q(f.item.text)}. Return it as a note (parent_code ${q(f.code!)}) with its exact wording, page and an exact quote copied from that page. If it is not on these pages, answer found=false and say why.`;
      }
      return `Re-cite the requirement coded ${q(f.code!)}, proposed as: ${q(f.item?.text ?? '')}. Return it with its exact wording, page and an exact quote copied from that page. If it is not on these pages, answer found=false and say why.`;
    case 'uncovered_page':
      return `Nothing was taken from page ${f.page}, though it has text. Does it state any requirement, or a note on one? If so, return each, copied exactly, citing page ${f.page}. If not, answer found=false and say what the page is (for example, an introduction).`;
    case 'conflict':
      return '';
  }
}

/**
 * One round's calls: the open gaps that can be asked about (they have pages), grouped by document and pages so that
 * questions about the same pages share a call, in reading order, within the per-round limits.
 */
export function planTasks(open: FoundGap[]): RecoveryTask[] {
  const groups = new Map<string, { documentId: string; pages: number[]; gaps: FoundGap[] }>();
  for (const f of [...open].sort((a, b) => a.anchorSeq - b.anchorSeq)) {
    if (!f.documentId || !f.pages.length || f.kind === 'conflict') continue;
    const k = `${f.documentId}|${f.pages.join(',')}`;
    if (!groups.has(k)) groups.set(k, { documentId: f.documentId, pages: f.pages, gaps: [] });
    groups.get(k)!.gaps.push(f);
  }
  const tasks: RecoveryTask[] = [];
  for (const g of groups.values()) {
    for (let i = 0; i < g.gaps.length; i += MAX_QUESTIONS_PER_TASK) {
      if (tasks.length >= MAX_TASKS_PER_ROUND) return tasks;
      tasks.push({
        documentId: g.documentId, pages: g.pages,
        questions: g.gaps.slice(i, i + MAX_QUESTIONS_PER_TASK).map((f, n) => ({ id: `q${n + 1}`, key: f.key, text: questionFor(f), anchorSeq: f.anchorSeq })),
      });
    }
  }
  return tasks;
}

/** Counts for the run's stats: where the gaps ended up. */
export function gapCounts(gaps: AnalysisGap[]) {
  const by = (s: AnalysisGap['status']) => gaps.filter((g) => g.status === s).length;
  return {
    gapsRecovered: by('recovered'),
    gapsUnresolved: by('unresolved') + by('open'),
    gapsConfirmedAbsent: by('confirmed_absent'),
    conflicts: by('conflict'),
    uncoveredPages: gaps.filter((g) => g.kind === 'uncovered_page' && g.status !== 'recovered').length,
  };
}

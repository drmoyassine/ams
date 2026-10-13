// The concrete form of a change set (DEC-027 Phase 2): the OPERATIONS the model chose (and the person confirmed) are turned,
// by ordinary code reading the current data, into an ordered list of STEPS: each step is one call of an existing core service
// with exact ids and values. The steps are what is dry-run, hashed, shown (counts, examples) and executed.
import type { ChangeCounts, ChangeExample } from '@ams/shared';

/** The fields a rule or a person may set on a requirement row. */
export interface ReqPatch {
  code?: string; title?: string; officialText?: string | null; levelLabel?: string; isAssessable?: boolean; language?: string; translationEn?: string | null;
}

export type Step =
  | { kind: 'req_fields'; opIndex: number; id: string; code: string; set: ReqPatch; was: ReqPatch; written?: boolean }
  | { kind: 'note_fields'; opIndex: number; id: string; requirementCode: string; set: { text?: string; type?: string }; was: { text?: string; type?: string } }
  | { kind: 'note_authority'; opIndex: number; id: string; requirementCode: string; authority: string; was: string }
  | { kind: 'move'; opIndex: number; moves: { id: string; parentId: string | null; index: number }[]; label: string }
  | { kind: 'create'; opIndex: number; tempId: string; parentId: string | null; code: string; levelLabel: string; title: string; officialText: string | null; isAssessable: boolean; language: string; displayOrder: number }
  | { kind: 'delete'; opIndex: number; ids: string[]; codes: string[] }
  | { kind: 'merge'; opIndex: number; id: string; intoId: string; code: string; intoCode: string; useMergedWording: boolean }
  | { kind: 'split'; opIndex: number; tempId: string; id: string; code: string; part: string; newCode: string; title: string | null }
  | { kind: 'link_review'; opIndex: number; id: string; externalCode: string; internalCode: string; decision: 'approved' | 'rejected' }
  | { kind: 'new_draft'; opIndex: number; sourceVersionId: string; edition: string; changeSummary: string | null };

export interface SkippedItem { code: string | null; reason: string }
export interface DeleteNote { code: string; title: string; subItems: number; notes: number }

/** A text the model wrote that will be marked "written by the assistant" once applied. */
export interface WrittenItem { requirementId: string; code: string; field: 'title' | 'officialText' | 'translationEn'; text: string; previous: string | null }

export interface Plan {
  versionId: string;
  versionLabel: string;
  steps: Step[];
  /** Item changes per operation (rows touched). */
  perOp: { opIndex: number; op: string; label: string; items: number }[];
  items: number;
  examples: ChangeExample[];
  skipped: SkippedItem[];
  skippedCount: number;
  deletes: DeleteNote[];
  deletesCount: number;
  warnings: string[];
  /** Things that make the change set impossible as asked (a cycle, a collision, a frozen version ...). Empty: it can be applied. */
  problems: string[];
  /** Item changes that were left out because of the limit (the next step). */
  remaining: number;
  linksByCode: number;
  written: WrittenItem[];
  newDraft: { edition: string } | null;
  /** SHA-256 of the steps (ids, values, earlier values). */
  planHash: string;
  counts: ChangeCounts;
}

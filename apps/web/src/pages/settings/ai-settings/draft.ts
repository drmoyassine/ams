import { DEFAULT_ASSISTANT_TURN_TOKENS, DEFAULT_OCR_MAX_PAGES, type AiCapUnit, type AiSetting, type UpdateAiSetting } from '@ams/shared';

/** The editable form state of the Models and Limits tabs. Ids are '' when nothing is chosen. */
export interface Draft {
  enabled: boolean;
  analysis: { accountId: string; model: string };
  reading: { same: boolean; accountId: string; model: string; ocrEnabled: boolean; maxPages: string; language: string };
  embeddings: { enabled: boolean; accountId: string; model: string };
  /** The in-app assistant: its switch, its account and model (`same`: those of analysis) and the cap on one answer, as typed. */
  assistant: { enabled: boolean; same: boolean; accountId: string; model: string; maxTokens: string };
  capUnit: AiCapUnit;
  /** The token cap in millions, as typed. */
  capMillions: string;
  capUsd: string;
  rounds: string;
}

const MILLION = 1_000_000;
const show = (n: number | null) => (n === null ? '' : String(n));
/** 1500000 -> "1.5". */
export const millionsOf = (tokens: number | null) => (tokens === null ? '' : String(Math.round((tokens / MILLION) * 1000) / 1000));

export function draftFrom(s: AiSetting): Draft {
  const r = s.reading;
  const same = !r.accountId && !r.model;
  return {
    enabled: s.enabled,
    analysis: { accountId: s.analysis.accountId ?? '', model: s.analysis.model ?? '' },
    reading: { same, accountId: r.accountId ?? s.analysis.accountId ?? '', model: r.model ?? '', ocrEnabled: r.ocrEnabled, maxPages: String(r.maxPages), language: r.language ?? '' },
    embeddings: { enabled: s.embeddings.enabled, accountId: s.embeddings.accountId ?? '', model: s.embeddings.model ?? '' },
    assistant: {
      enabled: s.assistant.enabled, same: !s.assistant.accountId && !s.assistant.model, accountId: s.assistant.accountId ?? s.analysis.accountId ?? '',
      model: s.assistant.model ?? '', maxTokens: String(s.assistant.maxTokensPerTurn),
    },
    capUnit: s.cap.unit, capMillions: millionsOf(s.cap.tokens), capUsd: show(s.cap.usd), rounds: String(s.maxRecoveryRounds),
  };
}

/** What Save sends. With no analysis account the server environment supplies the model, so none is stored. */
export function patchFrom(d: Draft): UpdateAiSetting {
  const a = d.analysis;
  const r = d.reading;
  const pages = Number(r.maxPages);
  return {
    enabled: d.enabled,
    analysis: { accountId: a.accountId || null, model: a.accountId ? a.model.trim() || null : null },
    reading: {
      accountId: r.same ? null : r.accountId || null, model: r.same ? null : r.model.trim() || null,
      ocrEnabled: r.ocrEnabled, ...(Number.isInteger(pages) && pages > 0 ? { maxPages: pages } : { maxPages: DEFAULT_OCR_MAX_PAGES }), language: r.language || null,
    },
    embeddings: { enabled: d.embeddings.enabled, accountId: d.embeddings.accountId || null, model: d.embeddings.model.trim() || null },
    assistant: {
      enabled: d.assistant.enabled, accountId: d.assistant.same ? null : d.assistant.accountId || null, model: d.assistant.same ? null : d.assistant.model.trim() || null,
      maxTokensPerTurn: Number.isInteger(Number(d.assistant.maxTokens)) && Number(d.assistant.maxTokens) >= 1000 ? Number(d.assistant.maxTokens) : DEFAULT_ASSISTANT_TURN_TOKENS,
    },
    cap: {
      unit: d.capUnit,
      tokens: d.capMillions.trim() === '' ? null : Math.max(1, Math.round(Number(d.capMillions) * MILLION)),
      usd: d.capUsd.trim() === '' ? null : Number(d.capUsd),
    },
    ...(d.rounds.trim() === '' ? {} : { maxRecoveryRounds: Number(d.rounds) }),
  };
}

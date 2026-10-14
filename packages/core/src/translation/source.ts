// The translation job's contract with whatever it translates (TASK-070). The engine (engine.ts) knows nothing about the
// interface catalogue, the IQF, standards or the glossary: it asks a TranslationSource what is pending, translates it in
// batches through aiExtract, and hands the checked results back to the same source to store. TASK-071 adds content kinds by
// registering more sources; the engine does not change.
import { createHash } from 'node:crypto';
import type { TranslationKind } from '@ams/shared';
import { nfc } from '@ams/shared';
import type { Ctx } from '../ctx.js';

/** One text to translate. `id` is the source's own key (a catalogue key, a requirement id + field...). */
export interface TranslationItem {
  id: string;
  /** The English. */
  text: string;
  /** Hash of the English at listing time; stored with the translation so a later English edit shows it out of date. */
  hash: string;
  /** Where the text is used (shown to the model, never translated). */
  context?: string;
}

export interface PendingOptions {
  /** Also list machine translations nobody has reviewed whose English changed since. Never a person's or reviewed row. */
  includeStale: boolean;
  /** Narrows content kinds (for example a framework version); null for the whole kind. */
  scopeId: string | null;
}

export interface TranslationSource {
  kind: TranslationKind;
  /** Items still to translate for `language`, in a stable order. Must not list what a person wrote or reviewed. */
  listPending(ctx: Ctx, language: string, options: PendingOptions): Promise<TranslationItem[]>;
  /**
   * Stores checked translations as origin 'ai', reviewed false. Must leave a person's or reviewed row alone (the database
   * guard refuses the worker anyway). Returns how many were stored.
   */
  saveTranslations(ctx: Ctx, input: { language: string; scopeId: string | null; runId: string; results: { item: TranslationItem; text: string }[] }): Promise<number>;
}

const sources = new Map<string, TranslationSource>();
export function registerTranslationSource(source: TranslationSource) { sources.set(source.kind, source); }
export function translationSourceFor(kind: string): TranslationSource {
  const s = sources.get(kind);
  if (!s) throw new Error(`No translation source registered for "${kind}"`);
  return s;
}

/** The hash recorded with a translation: first 16 hex characters of SHA-256 of the NFC English. */
export const sourceHash = (english: string) => createHash('sha256').update(nfc(english)).digest('hex').slice(0, 16);

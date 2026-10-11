import type { Dispatch, SetStateAction } from 'react';
import { ROUGH_TOKENS_PER_SOURCE_PAGE, type AiCapUnit } from '@ams/shared';
import { Card } from '../../../components/ui/card';
import { Input } from '../../../components/ui/input';
import type { Draft } from './draft';
import { field, hint, Select } from './common';

/** One cap per analysis run. Tokens always; US dollars only when the provider's own list gives the model's price. */
export function LimitsTab({ draft, setDraft, canEdit, usdAvailable }: { draft: Draft; setDraft: Dispatch<SetStateAction<Draft>>; canEdit: boolean; usdAvailable: boolean }) {
  const millions = Number(draft.capMillions);
  const pages = Number.isFinite(millions) && millions > 0 ? Math.round((millions * 1_000_000) / ROUGH_TOKENS_PER_SOURCE_PAGE) : null;
  return (
    <Card>
      <h2 className="mb-1 text-lg font-semibold">Spend cap</h2>
      <p className="mb-3 text-sm text-muted-foreground">An analysis run stops when it reaches the cap. Empty means no cap.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Select label="Cap unit" value={draft.capUnit} disabled={!canEdit} onChange={(v) => setDraft((d) => ({ ...d, capUnit: v as AiCapUnit }))}
          note={usdAvailable ? undefined : 'US dollars are available only when the provider lists the model\'s price (OpenRouter does).'}>
          <option value="tokens">Tokens</option>
          <option value="usd" disabled={!usdAvailable && draft.capUnit !== 'usd'}>US dollars{usdAvailable ? '' : ' (price not known)'}</option>
        </Select>
        {draft.capUnit === 'tokens' ? (
          <label className={field}>Cap per analysis run (millions of tokens)
            <Input aria-label="Cap per analysis run" type="number" inputMode="decimal" min={0.01} step="any" value={draft.capMillions} onChange={(e) => setDraft((d) => ({ ...d, capMillions: e.target.value }))} disabled={!canEdit} placeholder="No cap" />
            <span className={hint} data-testid="cap-helper">{pages ? `About ${pages.toLocaleString('en')} pages of source text (a very rough guide).` : 'Tokens are the pieces of text a model reads and writes.'}</span>
          </label>
        ) : (
          <label className={field}>Cap per analysis run (US dollars)
            <Input aria-label="Cap per analysis run" type="number" inputMode="decimal" min={0.01} step="any" value={draft.capUsd} onChange={(e) => setDraft((d) => ({ ...d, capUsd: e.target.value }))} disabled={!canEdit} placeholder="No cap" />
            <span className={hint}>Counted from the provider's own price for the analysis model.</span>
          </label>
        )}
      </div>
      <details className="mt-4">
        <summary className="cursor-pointer text-sm font-medium">Advanced</summary>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className={field}>Recovery rounds
            <Input aria-label="Recovery rounds" inputMode="numeric" type="number" min={0} max={5} step={1} value={draft.rounds} onChange={(e) => setDraft((d) => ({ ...d, rounds: e.target.value }))} disabled={!canEdit} />
            <span className={hint}>How many times to re-read pages where something looks missing. 0 to 5; 0 is off.</span>
          </label>
        </div>
      </details>
    </Card>
  );
}

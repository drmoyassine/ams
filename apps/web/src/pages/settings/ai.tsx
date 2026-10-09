import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AiSetting, AiTestResult, UpdateAiSetting } from '@ams/shared';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import { can, useMe } from '../../lib/me';
import { useSettingsApi, type SettingsApi } from '../../lib/settings-api';
import { useAction } from '../../lib/use-action';

const field = 'flex flex-col gap-1 text-sm';
const hint = 'text-xs text-muted-foreground';
const toNumber = (v: string) => (v.trim() === '' ? null : Number(v));
const show = (n: number | null) => (n === null ? '' : String(n));

function Switch({ label, checked, onChange, disabled, description }: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; description?: string }) {
  const id = useId();
  return (
    <div className="flex items-start gap-3">
      <input id={id} type="checkbox" role="switch" aria-checked={checked} checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="mt-1 h-5 w-5 shrink-0" />
      <label htmlFor={id} className="text-sm">
        <span className="font-medium">{label}</span>
        {description && <span className={`block ${hint}`}>{description}</span>}
      </label>
    </div>
  );
}

/** A write-only key field: the saved key is never shown, only whether one is set and its last 4 characters. */
function KeyField({ label, configured, last4, value, onChange, remove, onRemove, disabled, children }: {
  label: string; configured: boolean; last4: string | null; value: string; onChange: (v: string) => void; remove: boolean; onRemove: (v: boolean) => void; disabled: boolean; children?: ReactNode;
}) {
  return (
    <div className={field}>
      <label className={field}>{label}
        <Input type="password" autoComplete="off" spellCheck={false} aria-label={label} value={value} disabled={disabled || remove}
          placeholder={configured ? `Saved, ending in ${last4 ?? '****'}. Type to replace.` : 'Not set'} onChange={(e) => onChange(e.target.value)} />
      </label>
      <span className={hint} data-testid={`${label}-status`}>{remove ? 'The saved key will be removed when you save.' : configured ? `A key is saved (ends in ${last4 ?? '****'}). It is never shown again.` : 'No key saved.'}</span>
      {configured && !disabled && (
        <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={remove} onChange={(e) => { onRemove(e.target.checked); if (e.target.checked) onChange(''); }} /> Remove the saved key</label>
      )}
      {children}
    </div>
  );
}

function AiForm({ api, initial, canEdit }: { api: SettingsApi; initial: AiSetting; canEdit: boolean }) {
  const qc = useQueryClient();
  const e0 = initial.embeddings;
  const [model, setModel] = useState(initial.model ?? '');
  const [apiKey, setApiKey] = useState('');
  const [removeKey, setRemoveKey] = useState(false);
  const [enabled, setEnabled] = useState(initial.enabled);
  const [maxTokens, setMaxTokens] = useState(show(initial.maxTokensPerRun));
  const [maxCost, setMaxCost] = useState(show(initial.maxCostUsdPerRun));
  const [inPrice, setInPrice] = useState(show(initial.inputUsdPerMTok));
  const [outPrice, setOutPrice] = useState(show(initial.outputUsdPerMTok));
  const [rounds, setRounds] = useState(String(initial.maxRecoveryRounds));
  const [eEnabled, setEEnabled] = useState(e0.enabled);
  const [eUrl, setEUrl] = useState(e0.baseUrl ?? '');
  const [eModel, setEModel] = useState(e0.model ?? '');
  const [eKey, setEKey] = useState('');
  const [eRemoveKey, setERemoveKey] = useState(false);
  const [eDim, setEDim] = useState(show(e0.dimension));
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<AiTestResult | null>(null);
  const act = useAction(setError);

  const save = useMutation({
    mutationFn: async () => {
      setError(null); setSaved(false);
      const patch: UpdateAiSetting = {
        model: model.trim() || null, enabled,
        maxTokensPerRun: toNumber(maxTokens), maxCostUsdPerRun: toNumber(maxCost), inputUsdPerMTok: toNumber(inPrice), outputUsdPerMTok: toNumber(outPrice),
        ...(rounds.trim() === '' ? {} : { maxRecoveryRounds: Number(rounds) }),
        ...(removeKey ? { apiKey: null } : apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        embeddings: {
          enabled: eEnabled, baseUrl: eUrl.trim() || null, model: eModel.trim() || null, dimension: toNumber(eDim),
          ...(eRemoveKey ? { apiKey: null } : eKey.trim() ? { apiKey: eKey.trim() } : {}),
        },
      };
      const r = await act(() => api.updateAiSettings(patch));
      if (r) { setSaved(true); setApiKey(''); setRemoveKey(false); setEKey(''); setERemoveKey(false); await qc.invalidateQueries({ queryKey: ['ai-settings'] }); }
    },
  });
  const runTest = async () => {
    setTesting(true); setTest(null); setError(null);
    try { setTest(await api.testAi()); } catch (e) { setError(e instanceof Error ? e.message : 'The test could not be run'); } finally { setTesting(false); }
  };
  const submit = (e: FormEvent) => { e.preventDefault(); save.mutate(); };
  const dirty = apiKey !== '' || eKey !== '';

  return (
    <form onSubmit={submit} className="space-y-6" aria-label="AI settings" autoComplete="off">
      <Card>
        <h2 className="mb-1 text-lg font-semibold">Model</h2>
        <p className="mb-3 text-sm text-muted-foreground">
          {canEdit ? 'Used when standards are analysed. Anything the model writes stays a proposal until a person accepts it.' : 'Only an administrator can change these.'}
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className={field}>Provider
            <select aria-label="Provider" className="rounded-md border border-border bg-background px-2 py-2 text-sm" value={initial.provider} disabled>
              <option value="anthropic">Anthropic</option>
            </select>
          </label>
          <label className={field}>Model
            <Input aria-label="Model" value={model} onChange={(e) => setModel(e.target.value)} disabled={!canEdit} placeholder="Model name from your provider" />
          </label>
          <div className="sm:col-span-2">
            <KeyField label="API key" configured={initial.keyConfigured && initial.keySource === 'settings'} last4={initial.keyLast4} value={apiKey} onChange={setApiKey}
              remove={removeKey} onRemove={setRemoveKey} disabled={!canEdit}>
              {initial.keySource === 'environment' && <span className={hint}>The server environment supplies a key; a key saved here takes precedence.</span>}
            </KeyField>
          </div>
          <div className="sm:col-span-2">
            <Switch label="AI is on" checked={enabled} onChange={setEnabled} disabled={!canEdit} description="When off, document analysis jobs stop with a clear message instead of calling the model." />
          </div>
        </div>
      </Card>

      <Card>
        <h2 className="mb-1 text-lg font-semibold">Spend limits</h2>
        <p className="mb-3 text-sm text-muted-foreground">Per run, meaning one background job. A run stops when a limit is reached. Leave a limit empty for none.</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className={field}>Max tokens per run
            <Input aria-label="Max tokens per run" inputMode="numeric" type="number" min={1} step={1} value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} disabled={!canEdit} />
          </label>
          <label className={field}>Max cost per run (USD)
            <Input aria-label="Max cost per run (USD)" inputMode="decimal" type="number" min={0} step="any" value={maxCost} onChange={(e) => setMaxCost(e.target.value)} disabled={!canEdit} />
          </label>
          <label className={field}>Price per million input tokens (USD)
            <Input aria-label="Price per million input tokens (USD)" inputMode="decimal" type="number" min={0} step="any" value={inPrice} onChange={(e) => setInPrice(e.target.value)} disabled={!canEdit} />
          </label>
          <label className={field}>Price per million output tokens (USD)
            <Input aria-label="Price per million output tokens (USD)" inputMode="decimal" type="number" min={0} step="any" value={outPrice} onChange={(e) => setOutPrice(e.target.value)} disabled={!canEdit} />
          </label>
          <span className={`${hint} sm:col-span-2`}>A cost limit needs both prices, to count the cost. Take them from your provider's price list.</span>
          <label className={field}>Recovery rounds
            <Input aria-label="Recovery rounds" inputMode="numeric" type="number" min={0} max={5} step={1} value={rounds} onChange={(e) => setRounds(e.target.value)} disabled={!canEdit} />
            <span className={hint}>After analysing a standard's sources, how many times to go back for what looks missing (a skipped number, a quote not found, a page nothing was taken from). 0 to 5; 0 turns it off. The limits above still apply.</span>
          </label>
        </div>
      </Card>

      <Card>
        <h2 className="mb-1 text-lg font-semibold">Embeddings</h2>
        <p className="mb-3 text-sm text-muted-foreground">
          Ranks which requirements to compare. It only orders a shortlist; it never decides anything. Without it, ranking uses wording and codes alone.
          Works with any OpenAI-compatible endpoint, hosted or inside your own network. Only standards' wording is sent: never evidence or data.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Switch label="Embeddings are on" checked={eEnabled} onChange={setEEnabled} disabled={!canEdit} />
          </div>
          <label className={`${field} sm:col-span-2`}>Base URL
            <Input aria-label="Base URL" type="url" inputMode="url" value={eUrl} onChange={(e) => setEUrl(e.target.value)} disabled={!canEdit} placeholder="https://host.example/v1" />
          </label>
          <label className={field}>Embedding model
            <Input aria-label="Embedding model" value={eModel} onChange={(e) => setEModel(e.target.value)} disabled={!canEdit} />
            <span className={hint}>Must be a multilingual model, so Arabic and English wording compare well.</span>
          </label>
          <label className={field}>Vector dimension
            <Input aria-label="Vector dimension" inputMode="numeric" type="number" min={8} step={1} value={eDim} onChange={(e) => setEDim(e.target.value)} disabled={!canEdit} />
            <span className={hint}>The number of values the model returns for each text.</span>
          </label>
          <div className="sm:col-span-2">
            <KeyField label="Embeddings API key" configured={e0.keyConfigured} last4={e0.keyLast4} value={eKey} onChange={setEKey}
              remove={eRemoveKey} onRemove={setERemoveKey} disabled={!canEdit}>
              <span className={hint}>Optional for servers that need no key.</span>
            </KeyField>
          </div>
        </div>
      </Card>

      {canEdit && (
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={save.isPending}>Save</Button>
          <Button type="button" variant="outline" onClick={runTest} disabled={testing || dirty} title={dirty ? 'Save the new key first' : undefined}>
            {testing ? 'Testing…' : 'Test connection'}
          </Button>
          <span className={hint}>The test uses the saved settings.</span>
          {saved && <span role="status" className="text-sm text-emerald-800">Saved.</span>}
          {error && <span role="alert" className="text-sm text-red-700">{error}</span>}
        </div>
      )}
      <div aria-live="polite">
        {test && (
          <Card data-testid="ai-test-result">
            <h2 className="mb-1 text-base font-semibold">Connection test</h2>
            <p className={`text-sm ${test.ok ? 'text-emerald-800' : 'text-red-700'}`} role={test.ok ? 'status' : 'alert'}>
              Model: {test.ok ? `connected${test.model ? ` (${test.model})` : ''} in ${test.ms} ms.` : `failed. ${test.error ?? ''}`}
            </p>
            {test.embeddings && (
              <p className={`text-sm ${test.embeddings.ok ? 'text-emerald-800' : 'text-red-700'}`} role={test.embeddings.ok ? 'status' : 'alert'}>
                Embeddings: {test.embeddings.ok ? `connected, ${test.embeddings.dimension} values per text, in ${test.embeddings.ms} ms.` : `failed. ${test.embeddings.error ?? ''}`}
              </p>
            )}
          </Card>
        )}
      </div>
    </form>
  );
}

/** Settings -> AI: the connection, spend limits and embeddings. Administrators only; the key is write-only. */
export function AiSettingsPage({ api: override }: { api?: SettingsApi }) {
  const api = useSettingsApi(override);
  const me = useMe(api);
  const allowed = can(me.data, 'ai:manage');
  const { data, error } = useQuery({ queryKey: ['ai-settings'], queryFn: () => api.aiSettings(), enabled: allowed });
  if (me.data && !allowed) return <Card><p className="text-sm text-muted-foreground">Only an administrator can see the AI settings.</p></Card>;
  if (error) return <Card><p role="alert" className="text-sm text-red-700">{error instanceof Error ? error.message : 'Could not load the AI settings'}</p></Card>;
  if (!data) return <Card><p className="text-sm text-muted-foreground">Loading…</p></Card>;
  // Keyed by the saved values so a save (or another admin's change) refreshes the form, and a background refetch does not reset typing.
  return <AiForm key={JSON.stringify(data)} api={api} initial={data} canEdit={allowed} />;
}

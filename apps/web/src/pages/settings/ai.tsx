import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AI_PROVIDERS, AI_PROVIDER_LABELS, type AiProvider, type AiSetting, type AiTestResult, type UpdateAiSetting } from '@ams/shared';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import { can, useMe } from '../../lib/me';
import { useSettingsApi, type SettingsApi } from '../../lib/settings-api';
import { useAction } from '../../lib/use-action';

const TABS = [
  { id: 'connection', label: 'Connection' },
  { id: 'limits', label: 'Limits' },
  { id: 'embeddings', label: 'Embeddings' },
] as const;
type Tab = (typeof TABS)[number]['id'];
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

function AiForm({ api, initial, canEdit, tab, setTab }: { api: SettingsApi; initial: AiSetting; canEdit: boolean; tab: Tab; setTab: (t: Tab) => void }) {
  const qc = useQueryClient();
  const e0 = initial.embeddings;
  const [provider, setProvider] = useState<AiProvider>(initial.provider);
  const [baseUrl, setBaseUrl] = useState(initial.baseUrl ?? '');
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
        provider, baseUrl: provider === 'openai_compatible' ? baseUrl.trim() || null : null,
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
  const switching = provider !== initial.provider;

  return (
    <form onSubmit={submit} className="space-y-4" aria-label="AI settings" autoComplete="off">
      <div role="tablist" aria-label="AI settings sections" className="flex gap-1 overflow-x-auto border-b border-border">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" id={`ai-tab-${t.id}`} aria-selected={tab === t.id} aria-controls={`ai-panel-${t.id}`} onClick={() => setTab(t.id)}
            className={`shrink-0 whitespace-nowrap px-3 py-2 text-sm ${tab === t.id ? 'border-b-2 border-primary font-medium' : 'text-muted-foreground'}`}>{t.label}</button>
        ))}
      </div>
      {tab === 'connection' && <div role="tabpanel" id="ai-panel-connection" aria-labelledby="ai-tab-connection"><Card>
        <h2 className="mb-1 text-lg font-semibold">Model</h2>
        <p className="mb-3 text-sm text-muted-foreground">
          {canEdit ? 'Used to analyse standards. Its output is a draft until a person publishes it.' : 'Only an administrator can change these.'}
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className={field}>Provider
            <select aria-label="Provider" value={provider} onChange={(e) => setProvider(e.target.value as AiProvider)} disabled={!canEdit}
              className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm">
              {AI_PROVIDERS.map((p) => <option key={p} value={p}>{AI_PROVIDER_LABELS[p]}</option>)}
            </select>
            {switching && initial.keySource === 'settings'
              ? <span className={hint}>Changing the provider removes the saved API key; enter the key for the new provider.</span>
              : <span className={hint}>{provider === 'openai_compatible' ? 'Any server with an OpenAI-style API: OpenRouter, Ollama, vLLM, LM Studio, Azure and others.' : 'Which company runs the model.'}</span>}
          </label>
          {provider === 'openai_compatible' && (
            <label className={field}>Base URL
              <Input aria-label="Base URL" type="url" inputMode="url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} disabled={!canEdit} placeholder="https://host.example/v1" />
              <span className={hint}>Ollama: http://host:11434/v1. No user name or password in the address.</span>
            </label>
          )}
          <label className={`${field} ${provider === 'openai_compatible' ? 'sm:col-span-2' : ''}`}>Model
            <Input aria-label="Model" value={model} onChange={(e) => setModel(e.target.value)} disabled={!canEdit} placeholder="Model name from your provider" />
            <span className={hint}>{provider === 'openai_compatible' ? 'The model name the server expects, as it lists it.' : `The model name exactly as ${AI_PROVIDER_LABELS[provider]} lists it.`}</span>
          </label>
          <div className="sm:col-span-2">
            <KeyField label="API key" configured={initial.keyConfigured && initial.keySource === 'settings'} last4={initial.keyLast4} value={apiKey} onChange={setApiKey}
              remove={removeKey} onRemove={setRemoveKey} disabled={!canEdit}>
              {provider === 'openai_compatible' && <span className={hint}>Optional for servers that need no key.</span>}
              {initial.keySource === 'environment' && <span className={hint}>The server environment supplies a key; a key saved here takes precedence.</span>}
            </KeyField>
          </div>
          <div className="sm:col-span-2">
            <Switch label="AI is on" checked={enabled} onChange={setEnabled} disabled={!canEdit} description="Off: analysis stops instead of calling the model." />
          </div>
        </div>
      </Card></div>}

      {tab === 'limits' && <div role="tabpanel" id="ai-panel-limits" aria-labelledby="ai-tab-limits"><Card>
        <h2 className="mb-1 text-lg font-semibold">Spend limits</h2>
        <p className="mb-3 text-sm text-muted-foreground">Per analysis run. It stops when a limit is reached. Empty means no limit.</p>
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
          <span className={`${hint} sm:col-span-2`}>A cost limit needs both prices (from your provider's price list).</span>
          <label className={field}>Recovery rounds
            <Input aria-label="Recovery rounds" inputMode="numeric" type="number" min={0} max={5} step={1} value={rounds} onChange={(e) => setRounds(e.target.value)} disabled={!canEdit} />
            <span className={hint}>How many times to re-read pages where something looks missing. 0 to 5; 0 is off.</span>
          </label>
        </div>
      </Card></div>}

      {tab === 'embeddings' && <div role="tabpanel" id="ai-panel-embeddings" aria-labelledby="ai-tab-embeddings"><Card>
        <h2 className="mb-1 text-lg font-semibold">Embeddings</h2>
        <p className="mb-3 text-sm text-muted-foreground">
          Helps find similar requirements, including across languages. Optional. Any OpenAI-compatible endpoint, hosted or your own.
          Only standards' wording is sent, never evidence or data.
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
      </Card></div>}

      {canEdit && (
        <div className="sticky bottom-0 -mx-1 flex flex-wrap items-center gap-3 border-t border-border bg-background px-1 py-3 items-center gap-3">
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

/** Settings -> AI: connection, limits and embeddings, one tab each. Administrators only; the key is write-only. */
export function AiSettingsPage({ api: override }: { api?: SettingsApi }) {
  const api = useSettingsApi(override);
  const me = useMe(api);
  const allowed = can(me.data, 'ai:manage');
  // Lives here, not in the form: a save re-keys the form, and the person should stay on the tab they were using.
  const [tab, setTab] = useState<Tab>('connection');
  const { data, error } = useQuery({ queryKey: ['ai-settings'], queryFn: () => api.aiSettings(), enabled: allowed });
  if (me.data && !allowed) return <Card><p className="text-sm text-muted-foreground">Only an administrator can see the AI settings.</p></Card>;
  if (error) return <Card><p role="alert" className="text-sm text-red-700">{error instanceof Error ? error.message : 'Could not load the AI settings'}</p></Card>;
  if (!data) return <Card><p className="text-sm text-muted-foreground">Loading…</p></Card>;
  // Keyed by the saved values so a save (or another admin's change) refreshes the form, and a background refetch does not reset typing.
  return <AiForm key={JSON.stringify(data)} api={api} initial={data} canEdit={allowed} tab={tab} setTab={setTab} />;
}

import { useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AiAccount, AiRole, AiSetting, AiTestResult } from '@ams/shared';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { can, useMe } from '../../lib/me';
import { useSettingsApi, type SettingsApi } from '../../lib/settings-api';
import { useAction } from '../../lib/use-action';
import { AccountsTab } from './ai-settings/accounts-tab';
import { hint, Switch } from './ai-settings/common';
import { draftFrom, patchFrom, type Draft } from './ai-settings/draft';
import { LimitsTab } from './ai-settings/limits-tab';
import { ModelsTab } from './ai-settings/models-tab';

const TABS = [
  { id: 'accounts', label: 'Accounts' },
  { id: 'models', label: 'Models' },
  { id: 'limits', label: 'Limits' },
] as const;
type Tab = (typeof TABS)[number]['id'];

function AiForm({ api, initial, accounts, canEdit, tab, setTab, saved, setSaved }: {
  api: SettingsApi; initial: AiSetting; accounts: AiAccount[]; canEdit: boolean; tab: Tab; setTab: (t: Tab) => void; saved: boolean; setSaved: (v: boolean) => void;
}) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Draft>(() => draftFrom(initial));
  const [error, setError] = useState<string | null>(null);
  const [tests, setTests] = useState<Partial<Record<AiRole, AiTestResult | 'running'>>>({});
  const act = useAction(setError);
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftFrom(initial));

  const save = useMutation({
    mutationFn: async () => {
      setError(null); setSaved(false);
      const r = await act(() => api.updateAiSettings(patchFrom(draft)));
      if (r) { setSaved(true); await qc.invalidateQueries({ queryKey: ['ai-settings'] }); await qc.invalidateQueries({ queryKey: ['ai-accounts'] }); }
    },
  });
  const runTest = async (role: AiRole) => {
    setTests((t) => ({ ...t, [role]: 'running' })); setError(null);
    try {
      const r = await api.testAi(role);
      setTests((t) => ({ ...t, [role]: r }));
      // The embeddings test stores the vector size it found.
      if (role === 'embeddings' && r.ok) await qc.invalidateQueries({ queryKey: ['ai-settings'] });
    } catch (e) {
      setTests((t) => ({ ...t, [role]: undefined }));
      setError(e instanceof Error ? e.message : 'The test could not be run');
    }
  };
  const submit = (e: FormEvent) => { e.preventDefault(); if (e.target === e.currentTarget) save.mutate(); };
  const env = initial.environment;

  return (
    <form onSubmit={submit} className="space-y-4" aria-label="AI settings" autoComplete="off">
      <Card>
        <Switch label="AI is on" checked={draft.enabled} onChange={(v) => setDraft((d) => ({ ...d, enabled: v }))} disabled={!canEdit}
          description={canEdit ? 'Off: analysis and reading by AI stop instead of calling a model.' : 'Only an administrator can change these.'} />
        {!initial.analysis.accountId && (
          <p className={`mt-2 ${hint}`} data-testid="env-note">
            No account is chosen for analysis, so the server's own settings are used
            {env.keyPresent && env.model ? ` (${env.provider}, ${env.model}).` : ', and they are not complete.'}
          </p>
        )}
      </Card>

      <div role="tablist" aria-label="AI settings sections" className="flex gap-1 overflow-x-auto border-b border-border">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" id={`ai-tab-${t.id}`} aria-selected={tab === t.id} aria-controls={`ai-panel-${t.id}`} onClick={() => setTab(t.id)}
            className={`shrink-0 whitespace-nowrap px-3 py-2 text-sm ${tab === t.id ? 'border-b-2 border-primary font-medium' : 'text-muted-foreground'}`}>{t.label}</button>
        ))}
      </div>
      {tab !== 'accounts' && <div role="tabpanel" id={`ai-panel-${tab}`} aria-labelledby={`ai-tab-${tab}`}>
        {tab === 'models' && <ModelsTab api={api} accounts={accounts} settings={initial} draft={draft} setDraft={setDraft} canEdit={canEdit} dirty={dirty} tests={tests} runTest={runTest} />}
        {tab === 'limits' && <LimitsTab draft={draft} setDraft={setDraft} canEdit={canEdit} usdAvailable={initial.cap.usdAvailable} />}
      </div>}

      {canEdit && tab !== 'accounts' && (
        <div className="sticky bottom-0 -mx-1 flex flex-wrap items-center gap-3 border-t border-border bg-background px-1 py-3">
          <Button type="submit" disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save'}</Button>
          <span className={hint}>{dirty ? 'You have unsaved changes.' : 'Tests use the saved settings.'}</span>
          {saved && !dirty && <span role="status" className="text-sm text-emerald-800">Saved.</span>}
          {error && <span role="alert" className="text-sm text-red-700">{error}</span>}
        </div>
      )}
    </form>
  );
}

/** Settings -> AI: accounts (saved connections), models (which account and model does what) and limits. Administrators only; keys are write-only. */
export function AiSettingsPage({ api: override }: { api?: SettingsApi }) {
  const api = useSettingsApi(override);
  const qc = useQueryClient();
  const me = useMe(api);
  const allowed = can(me.data, 'ai:manage');
  // Lives here, not in the form: a save re-keys the form, and the person should stay on the tab they were using.
  const [tab, setTab] = useState<Tab | null>(null);
  const [saved, setSaved] = useState(false);
  const firstTab = useRef<Tab | null>(null);
  const settings = useQuery({ queryKey: ['ai-settings'], queryFn: () => api.aiSettings(), enabled: allowed });
  const accounts = useQuery({ queryKey: ['ai-accounts'], queryFn: () => api.aiAccounts(), enabled: allowed });
  if (me.data && !allowed) return <Card><p className="text-sm text-muted-foreground">Only an administrator can see the AI settings.</p></Card>;
  const error = settings.error ?? accounts.error;
  if (error) return <Card><p role="alert" className="text-sm text-red-700">{error instanceof Error ? error.message : 'Could not load the AI settings'}</p></Card>;
  if (!settings.data || !accounts.data) return <Card><p className="text-sm text-muted-foreground">Loading…</p></Card>;
  // Opens on Accounts when there are none, else on Models; after that the person's own choice stands (adding the first account must not jump tabs).
  if (firstTab.current === null) firstTab.current = accounts.data.length ? 'models' : 'accounts';
  const onAccountsChanged = () => { void qc.invalidateQueries({ queryKey: ['ai-accounts'] }); void qc.invalidateQueries({ queryKey: ['ai-settings'] }); void qc.invalidateQueries({ queryKey: ['ai-models'] }); };
  const current = tab ?? firstTab.current;
  // The settings form is keyed by the saved values so a save (or another admin's change) refreshes it. The Accounts panel sits
  // OUTSIDE that form: its dialog has its own <form> (forms cannot nest, and its submit must never save the settings) and it
  // must survive the form being re-keyed while a person is typing a key.
  return (
    <div className="space-y-4">
      <AiForm key={JSON.stringify(settings.data)} api={api} initial={settings.data} accounts={accounts.data} canEdit={allowed}
        tab={current} setTab={setTab} saved={saved} setSaved={setSaved} />
      {current === 'accounts' && (
        <div role="tabpanel" id="ai-panel-accounts" aria-labelledby="ai-tab-accounts">
          <AccountsTab api={api} accounts={accounts.data} canEdit={allowed} onChanged={onAccountsChanged} />
        </div>
      )}
    </div>
  );
}

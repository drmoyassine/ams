import { useState, type FormEvent } from 'react';
import { AI_PROVIDERS, AI_PROVIDER_LABELS, type AiAccount, type AiProvider, type AiRole, type AiTestResult, type CreateAiAccount, type UpdateAiAccount } from '@ams/shared';
import { Button } from '../../../components/ui/button';
import { Card } from '../../../components/ui/card';
import { Dialog } from '../../../components/dialog';
import { Input } from '../../../components/ui/input';
import type { SettingsApi } from '../../../lib/settings-api';
import { useAction } from '../../../lib/use-action';
import { field, hint, providerLabelShort, selectClass, TestLine } from './common';

const ROLE_LABEL: Record<AiRole, string> = { analysis: 'Analysis', reading: 'Reading', embeddings: 'Embeddings' };

function keyText(a: AiAccount): string {
  if (a.keySource === 'saved') return `Key ends in …${a.keyLast4 ?? '****'}`;
  if (a.keySource === 'environment') return 'Using the server\'s key';
  return a.provider === 'openai_compatible' ? 'No key (not needed for some servers)' : 'No key yet';
}

/** Add or edit one account. The key is write-only: it is never shown, only replaced or removed. */
function AccountDialog({ api, account, onClose, onSaved }: { api: SettingsApi; account: AiAccount | null; onClose: () => void; onSaved: () => void }) {
  const [provider, setProvider] = useState<AiProvider>(account?.provider ?? 'openai');
  const [name, setName] = useState(account?.name ?? '');
  const [baseUrl, setBaseUrl] = useState(account?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState('');
  const [removeKey, setRemoveKey] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const act = useAction(setError);
  const inUse = (account?.usedFor.length ?? 0) > 0;
  const switching = !!account && provider !== account.provider;
  const compat = provider === 'openai_compatible';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null); setBusy(true);
    try {
      const r = await act(() => {
        if (!account) {
          const body: CreateAiAccount = { provider, ...(name.trim() ? { name: name.trim() } : {}), ...(compat ? { baseUrl: baseUrl.trim() } : {}), ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) };
          return api.createAiAccount(body);
        }
        const patch: UpdateAiAccount = {
          ...(name.trim() && name.trim() !== account.name ? { name: name.trim() } : {}), ...(switching ? { provider } : {}),
          ...(compat ? { baseUrl: baseUrl.trim() } : {}),
          ...(removeKey ? { apiKey: null } : apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        };
        return api.updateAiAccount(account.id, patch);
      });
      if (r) { onSaved(); onClose(); }
    } finally { setBusy(false); }
  };

  return (
    <Dialog labelledBy="ai-account-title" onClose={onClose} size="md">
      <div className="mb-3 flex items-start justify-between gap-3">
        <h2 id="ai-account-title" className="text-lg font-semibold">{account ? 'Edit account' : 'Add account'}</h2>
        <Button type="button" variant="ghost" onClick={onClose} aria-label="Close">Close</Button>
      </div>
      <form onSubmit={submit} className="space-y-3" autoComplete="off" aria-label={account ? 'Edit account' : 'Add account'}>
        <label className={field}>Provider
          <select aria-label="Provider" value={provider} onChange={(e) => setProvider(e.target.value as AiProvider)} disabled={inUse} className={selectClass}>
            {AI_PROVIDERS.map((p) => <option key={p} value={p}>{AI_PROVIDER_LABELS[p]}</option>)}
          </select>
          {inUse && <span className={hint}>This account is in use, so its provider cannot change.</span>}
          {switching && account?.keyConfigured && <span className={hint}>Changing the provider removes the saved key; enter the key for the new provider.</span>}
          {provider === 'openrouter' && <span className={hint}>OpenRouter needs only a key; its address is built in.</span>}
        </label>
        <label className={field}>Label
          <Input aria-label="Label" value={name} onChange={(e) => setName(e.target.value)} placeholder={providerLabelShort(AI_PROVIDER_LABELS[provider])} maxLength={80} />
          <span className={hint}>A name you will recognise, for example "Work OpenAI".</span>
        </label>
        {compat && (
          <label className={field}>Base URL
            <Input aria-label="Base URL" type="url" inputMode="url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://host.example/v1" />
            <span className={hint}>Ollama: http://host:11434/v1. No user name or password in the address.</span>
          </label>
        )}
        <div className={field}>
          <label className={field}>API key
            <Input type="password" autoComplete="off" spellCheck={false} aria-label="API key" value={apiKey} disabled={removeKey} onChange={(e) => setApiKey(e.target.value)}
              placeholder={account?.keyConfigured && !switching ? `Saved, ending in ${account.keyLast4 ?? '****'}. Type to replace.` : 'Paste the key'} />
          </label>
          <span className={hint} data-testid="key-status">
            {removeKey ? 'The saved key will be removed when you save.' : account?.keyConfigured && !switching ? 'A key is saved. It is never shown again.' : compat ? 'Optional for servers that need no key.' : 'Stored encrypted. It is never shown again.'}
          </span>
          {account?.keyConfigured && !switching && (
            <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={removeKey} onChange={(e) => { setRemoveKey(e.target.checked); if (e.target.checked) setApiKey(''); }} /> Remove the saved key</label>
          )}
        </div>
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={busy}>{account ? 'Save account' : 'Add account'}</Button>
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Saved connections: provider, label, the end of the key; test, edit, delete. Switching what is used is done under Models. */
export function AccountsTab({ api, accounts, canEdit, onChanged }: { api: SettingsApi; accounts: AiAccount[]; canEdit: boolean; onChanged: () => void }) {
  const [dialog, setDialog] = useState<{ account: AiAccount | null } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, AiTestResult | 'running'>>({});
  const [error, setError] = useState<string | null>(null);
  const act = useAction(setError);

  const test = async (a: AiAccount) => {
    setTests((t) => ({ ...t, [a.id]: 'running' }));
    try {
      const r = await api.testAiAccount(a.id);
      setTests((t) => ({ ...t, [a.id]: r }));
    } catch (e) {
      setTests((t) => ({ ...t, [a.id]: { ok: false, role: null, model: null, ms: 0, error: e instanceof Error ? e.message : 'The test could not be run', dimension: null } }));
    }
  };
  const remove = async (a: AiAccount) => {
    setError(null);
    const done = await act(async () => { await api.deleteAiAccount(a.id); return true; });
    setConfirming(null);
    if (done) onChanged();
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">Saved connections to AI providers. Keys are stored encrypted and never shown again.</p>
        {canEdit && <Button type="button" onClick={() => setDialog({ account: null })}>Add account</Button>}
      </div>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {accounts.length === 0 ? (
        <Card><p className="text-sm text-muted-foreground" data-testid="accounts-empty">No accounts yet. Add one to connect OpenAI, Anthropic, Google, OpenRouter or your own server, then choose what each task uses under Models.</p></Card>
      ) : (
        <ul className="space-y-3" aria-label="AI accounts">
          {accounts.map((a) => {
            const t = tests[a.id];
            return (
              <li key={a.id}>
                <Card>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="break-words text-base font-semibold">{a.name}</h3>
                      <p className="text-sm text-muted-foreground">{AI_PROVIDER_LABELS[a.provider]}{a.baseUrl ? ` · ${a.baseUrl}` : ''}</p>
                      <p className="text-sm" data-testid={`key-${a.name}`}>{keyText(a)}</p>
                      {a.usedFor.length > 0 && <p className={hint}>Used for {a.usedFor.map((r) => ROLE_LABEL[r]).join(', ')}</p>}
                    </div>
                    {canEdit && (
                      <div className="flex flex-wrap gap-2">
                        <Button type="button" variant="outline" onClick={() => test(a)} disabled={t === 'running'} aria-label={`Test ${a.name}`}>{t === 'running' ? 'Testing…' : 'Test'}</Button>
                        <Button type="button" variant="outline" onClick={() => setDialog({ account: a })} aria-label={`Edit ${a.name}`}>Edit</Button>
                        <Button type="button" variant="outline" onClick={() => setConfirming(a.id)} aria-label={`Delete ${a.name}`}>Delete</Button>
                      </div>
                    )}
                  </div>
                  {confirming === a.id && (
                    <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3" role="group" aria-label={`Confirm deleting ${a.name}`}>
                      <span className="text-sm">Delete "{a.name}" and its saved key?</span>
                      <Button type="button" onClick={() => remove(a)}>Delete account</Button>
                      <Button type="button" variant="outline" onClick={() => setConfirming(null)}>Keep it</Button>
                    </div>
                  )}
                  <div aria-live="polite" className="mt-2">
                    {t && t !== 'running' && <TestLine result={t} what={a.name} />}
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
      {dialog && <AccountDialog api={api} account={dialog.account} onClose={() => setDialog(null)} onSaved={onChanged} />}
    </div>
  );
}

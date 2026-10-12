import type { Dispatch, ReactNode, SetStateAction } from 'react';
import { AI_PROVIDER_LABELS, providerSupportsEmbeddings, type AiAccount, type AiRole, type AiSetting, type AiTestResult } from '@ams/shared';
import { Button } from '../../../components/ui/button';
import { Card } from '../../../components/ui/card';
import { Input } from '../../../components/ui/input';
import type { SettingsApi } from '../../../lib/settings-api';
import type { Draft } from './draft';
import { field, hint, Select, Switch, TestLine } from './common';
import { ModelPicker } from './model-picker';

const LANGUAGES: [string, string][] = [['', 'Auto (each source\'s own language)'], ['en', 'English'], ['ar', 'Arabic'], ['fr', 'French'], ['es', 'Spanish'], ['de', 'German'], ['tr', 'Turkish'], ['fa', 'Persian'], ['ur', 'Urdu']];

const accountOption = (a: AiAccount) => <option key={a.id} value={a.id}>{a.name} ({AI_PROVIDER_LABELS[a.provider].replace(/\s*\(.*\)$/, '')})</option>;

function Section({ title, intro, children, test, testLabel }: { title: string; intro: string; children: ReactNode; test?: ReactNode; testLabel?: string }) {
  return (
    <Card>
      <section aria-label={testLabel ?? title}>
        <h2 className="mb-1 text-lg font-semibold">{title}</h2>
        <p className="mb-3 text-sm text-muted-foreground">{intro}</p>
        <div className="grid gap-3 sm:grid-cols-2">{children}</div>
        {test && <div className="mt-3 space-y-1">{test}</div>}
      </section>
    </Card>
  );
}

/** Which account and model does what: Analysis, Reading / vision, Embeddings. One dropdown per role. */
export function ModelsTab({ api, accounts, settings, draft, setDraft, canEdit, dirty, tests, runTest }: {
  api: SettingsApi; accounts: AiAccount[]; settings: AiSetting; draft: Draft; setDraft: Dispatch<SetStateAction<Draft>>; canEdit: boolean; dirty: boolean;
  tests: Partial<Record<AiRole, AiTestResult | 'running'>>; runTest: (role: AiRole) => void;
}) {
  const set = <K extends keyof Draft>(key: K, patch: Partial<Draft[K]>) => setDraft((d) => ({ ...d, [key]: { ...(d[key] as object), ...patch } }));
  const embedAccounts = accounts.filter((a) => providerSupportsEmbeddings(a.provider));
  const noAccounts = accounts.length === 0;
  const testButton = (role: AiRole, label: string) => (
    <div className="flex flex-wrap items-center gap-2">
      <Button type="button" variant="outline" onClick={() => runTest(role)} disabled={!canEdit || dirty || tests[role] === 'running'} title={dirty ? 'Save your changes first' : undefined}>
        {tests[role] === 'running' ? 'Testing…' : label}
      </Button>
      {dirty && <span className={hint}>Save first: the test uses the saved settings.</span>}
    </div>
  );
  const result = (role: AiRole, what: string) => { const t = tests[role]; return t && t !== 'running' ? <TestLine result={t} what={what} /> : null; };
  const env = settings.environment;

  return (
    <div className="space-y-4">
      <Section title="Analysis" intro="Reads standards and drafts requirements. Its output is a draft until a person publishes it." testLabel="Analysis model"
        test={<><div aria-live="polite">{result('analysis', 'Analysis')}</div>{testButton('analysis', 'Test analysis')}</>}>
        <Select label="Analysis account" value={draft.analysis.accountId} disabled={!canEdit}
          onChange={(v) => set('analysis', { accountId: v, model: v === draft.analysis.accountId ? draft.analysis.model : '' })}
          note={draft.analysis.accountId === '' ? (noAccounts ? 'Add an account first (Accounts tab).' : 'Choose an account to use it.') : undefined}>
          <option value="">{env.keyPresent && env.model ? `Server settings (${AI_PROVIDER_LABELS[env.provider].replace(/\s*\(.*\)$/, '')})` : 'None'}</option>
          {accounts.map(accountOption)}
        </Select>
        <ModelPicker api={api} label="Analysis model" accountId={draft.analysis.accountId || null} kind="chat" value={draft.analysis.model} onChange={(v) => set('analysis', { model: v })} disabled={!canEdit}
          emptyHint={env.model ? `Using the server's model (${env.model}).` : ''} />
      </Section>

      <Section title="Reading and vision" intro="Reads scanned pages (OCR). By default it uses the analysis model; choose a cheaper vision model if you prefer." testLabel="Reading model"
        test={<><div aria-live="polite">{result('reading', 'Reading')}</div>{testButton('reading', 'Test reading')}</>}>
        <div className="sm:col-span-2">
          <Switch label="Read scanned pages with AI (OCR)" checked={draft.reading.ocrEnabled} onChange={(v) => set('reading', { ocrEnabled: v })} disabled={!canEdit}
            description="Off: scanned pages are left flagged as needing OCR." />
        </div>
        <Select label="Reading account" value={draft.reading.same ? '' : draft.reading.accountId} disabled={!canEdit}
          onChange={(v) => set('reading', v === '' ? { same: true } : { same: false, accountId: v, model: v === draft.reading.accountId ? draft.reading.model : '' })}>
          <option value="">Same as analysis</option>
          {accounts.map(accountOption)}
        </Select>
        {draft.reading.same
          ? <p className={`${hint} self-end`}>Uses the analysis model for scanned pages.</p>
          : <ModelPicker api={api} label="Reading model" accountId={draft.reading.accountId || null} kind="chat" value={draft.reading.model} onChange={(v) => set('reading', { model: v })} disabled={!canEdit} />}
        <label className={field}>Max AI-read pages per file
          <Input aria-label="Max AI-read pages per file" type="number" inputMode="numeric" min={1} max={5000} step={1} value={draft.reading.maxPages} onChange={(e) => set('reading', { maxPages: e.target.value })} disabled={!canEdit} />
          <span className={hint}>Pages beyond this stay flagged as needing OCR.</span>
        </label>
        <Select label="OCR language hint" value={draft.reading.language} onChange={(v) => set('reading', { language: v })} disabled={!canEdit}
          note="Auto uses each source's language. Pick one to tell the model the language of every scanned page.">
          {LANGUAGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          {draft.reading.language && !LANGUAGES.some(([v]) => v === draft.reading.language) && <option value={draft.reading.language}>{draft.reading.language}</option>}
        </Select>
      </Section>

      <Section title="Assistant" intro="The chat helper in the corner of every screen. It answers questions about the standards a person can open, and only drafts or reads; it never publishes. By default it uses the analysis model." testLabel="Assistant model"
        test={<><div aria-live="polite">{result('assistant', 'Assistant')}</div>{testButton('assistant', 'Test assistant')}</>}>
        <div className="sm:col-span-2">
          <Switch label="Assistant is on" checked={draft.assistant.enabled} onChange={(v) => set('assistant', { enabled: v })} disabled={!canEdit}
            description="Off: the chat button explains that the assistant is switched off. AI as a whole must also be on." />
        </div>
        <Select label="Assistant account" value={draft.assistant.same ? '' : draft.assistant.accountId} disabled={!canEdit}
          onChange={(v) => set('assistant', v === '' ? { same: true } : { same: false, accountId: v, model: v === draft.assistant.accountId ? draft.assistant.model : '' })}>
          <option value="">Same as analysis</option>
          {accounts.map(accountOption)}
        </Select>
        {draft.assistant.same
          ? <p className={`${hint} self-end`}>Uses the analysis model.</p>
          : <ModelPicker api={api} label="Assistant model" accountId={draft.assistant.accountId || null} kind="chat" value={draft.assistant.model} onChange={(v) => set('assistant', { model: v })} disabled={!canEdit} />}
        <label className={field}>Max tokens per answer
          <Input aria-label="Max tokens per answer" type="number" inputMode="numeric" min={1000} step={1000} value={draft.assistant.maxTokens} onChange={(e) => set('assistant', { maxTokens: e.target.value })} disabled={!canEdit} />
          <span className={hint}>One question and its lookups stop here. Each person can also ask a limited number of questions per hour.</span>
        </label>
      </Section>

      <Section title="Embeddings" intro="Helps find similar requirements, including across languages. Optional. Only standards' wording is sent, never evidence or data." testLabel="Embeddings model"
        test={<><div aria-live="polite">{result('embeddings', 'Embeddings')}</div>{testButton('embeddings', 'Test embeddings')}</>}>
        <div className="sm:col-span-2">
          <Switch label="Embeddings are on" checked={draft.embeddings.enabled} onChange={(v) => set('embeddings', { enabled: v })} disabled={!canEdit} />
        </div>
        <Select label="Embeddings account" value={draft.embeddings.accountId} disabled={!canEdit}
          onChange={(v) => set('embeddings', { accountId: v, model: v === draft.embeddings.accountId ? draft.embeddings.model : '' })}
          note={embedAccounts.length === 0 ? 'Add an OpenAI, Google, OpenRouter or OpenAI-compatible account. Anthropic has no embedding models.' : 'You can use the same account as analysis.'}>
          <option value="">None</option>
          {embedAccounts.map(accountOption)}
        </Select>
        <ModelPicker api={api} label="Embedding model" accountId={draft.embeddings.accountId || null} kind="embedding" value={draft.embeddings.model} onChange={(v) => set('embeddings', { model: v })} disabled={!canEdit}
          emptyHint="Use a multilingual model so Arabic and English wording compare well." />
        <p className={`${hint} sm:col-span-2`} data-testid="embedding-dimension">
          {settings.embeddings.dimension ? `Vector size: ${settings.embeddings.dimension} (found automatically).` : 'Vector size: found automatically when you save or test.'}
        </p>
      </Section>
    </div>
  );
}

import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Me } from '@ams/shared';
import { ContentText } from '../../components/content-text';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import type { EvidenceApi } from '../../lib/evidence-api';
import { requirementLabel } from '../../lib/format';
import type { FrameworkApi, Requirement, Version } from '../../lib/framework-api';
import { can } from '../../lib/me';
import { useAction } from '../../lib/use-action';
import { InternalEvidence } from '../version/requirements-tab';

/** The next free code: 1, 2, 3 for standards; 3.1, 3.2 under standard 3. */
function nextCode(rows: Requirement[], parent: Requirement | null): string {
  const siblings = rows.filter((r) => (r.parentId ?? null) === (parent?.id ?? null)).map((r) => r.code);
  const prefix = parent ? `${parent.code}.` : '';
  let n = siblings.length + 1;
  while (siblings.includes(`${prefix}${n}`)) n += 1;
  return `${prefix}${n}`;
}

function AddForm({ label, placeholder, onAdd }: { label: string; placeholder: string; onAdd: (title: string) => void }) {
  const [title, setTitle] = useState('');
  return (
    <form aria-label={label} className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (title.trim()) { onAdd(title.trim()); setTitle(''); } }}>
      <Input aria-label={`${label}: title`} placeholder={placeholder} value={title} onChange={(e) => setTitle(e.target.value)} dir="auto" />
      <Button type="submit" variant="ghost" disabled={!title.trim()}>{label}</Button>
    </form>
  );
}

/**
 * The internal framework's requirements: standards and their sub-standards, each a code, a title and a description,
 * with the evidence attached to it. Edited while the version is a draft.
 */
export function IqfRequirements({ api, version, me, evidence }: { api: FrameworkApi; version: Version; me: Me | undefined; evidence?: EvidenceApi }) {
  const qc = useQueryClient();
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const rows = useQuery({ queryKey: ['requirements', version.id], queryFn: () => api.requirements(version.id) });
  const run = useAction(setError);
  const refresh = () => qc.invalidateQueries({ queryKey: ['requirements', version.id] });
  const act = (fn: () => Promise<unknown>) => { setError(''); return run(fn).then(refresh); };
  const editable = version.status === 'draft' && can(me, 'framework:write');
  const all = rows.data ?? [];
  const current = all.find((r) => r.id === selected) ?? null;
  const children = (id: string) => all.filter((r) => r.parentId === id);
  const standards = all.filter((r) => !r.parentId);

  const add = (title: string, parent: Requirement | null) => act(async () => {
    const r = await api.createRequirement(version.id, { code: nextCode(all, parent), levelLabel: parent ? 'Sub-standard' : 'Standard', title, ...(parent ? { parentId: parent.id } : {}) });
    setSelected(r.id);
  });
  const save = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!current) return;
    const f = new FormData(e.currentTarget);
    void act(() => api.patchRequirement(current.id, { code: String(f.get('code')).trim(), title: String(f.get('title')).trim(), officialText: String(f.get('description')) }));
  };

  const item = (r: Requirement, sub: boolean) => (
    <button type="button" onClick={() => setSelected(r.id)} aria-current={selected === r.id ? 'true' : undefined}
      className={`w-full rounded px-2 py-1 text-start text-sm hover:bg-muted ${sub ? 'ps-6' : 'font-medium'} ${selected === r.id ? 'bg-muted' : ''}`}>
      <ContentText>{requirementLabel(r.code, r.title)}</ContentText>
    </button>
  );

  return (
    <div className="grid gap-6 md:grid-cols-2">
      <div className="space-y-3">
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        <ul aria-label="Standards" className="space-y-1">
          {standards.map((s) => (
            <li key={s.id}>
              {item(s, false)}
              {children(s.id).length > 0 && <ul aria-label={`Sub-standards of ${s.code}`}>{children(s.id).map((c) => <li key={c.id}>{item(c, true)}</li>)}</ul>}
            </li>
          ))}
          {rows.data && standards.length === 0 && <li className="text-sm text-muted-foreground">No standards yet.</li>}
        </ul>
        {editable && <AddForm label="Add standard" placeholder="New standard, e.g. Student support" onAdd={(t) => void add(t, null)} />}
      </div>

      <div>
        {!current && <p className="text-sm text-muted-foreground">Select a standard or sub-standard.</p>}
        {current && (
          <div className="space-y-4" data-testid="iqf-detail">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">{current.parentId ? 'Sub-standard' : 'Standard'}</p>
            <form key={`${current.id}|${current.code}|${current.title}|${current.officialText}`} onSubmit={save} className="space-y-2" aria-label="Edit">
              <div className="flex gap-2">
                <label className="flex w-24 flex-col text-sm">Code<Input name="code" aria-label="Code" defaultValue={current.code} readOnly={!editable} /></label>
                <label className="flex flex-1 flex-col text-sm">Title<Input name="title" aria-label="Title" defaultValue={current.title} readOnly={!editable} dir="auto" /></label>
              </div>
              <label className="flex flex-col text-sm">Description
                <textarea name="description" aria-label="Description" rows={4} dir="auto" defaultValue={current.officialText ?? ''} readOnly={!editable}
                  className="rounded-md border border-border p-2 text-sm" placeholder="What this standard expects" />
              </label>
              {editable && (
                <div className="flex gap-2">
                  <Button type="submit">Save</Button>
                  <Button type="button" variant="ghost" onClick={() => void act(async () => { await api.deleteRequirement(current.id); setSelected(null); })}>Delete</Button>
                </div>
              )}
            </form>
            {editable && !current.parentId && <AddForm label="Add sub-standard" placeholder={`New sub-standard under ${current.code}`} onAdd={(t) => void add(t, current)} />}
            <InternalEvidence requirementId={current.id} me={me} {...(evidence ? { evidence } : {})} />
          </div>
        )}
      </div>
    </div>
  );
}

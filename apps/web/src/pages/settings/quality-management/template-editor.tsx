// Settings -> Quality Management -> one cycle template: its details, its stages in order (each with inputs -> process -> outputs, who is
// responsible and when), live checks in plain words, a timeline preview, and Save draft / Publish / Revise (DEC-029, TASK-079).
// A draft can be saved unfinished (only a missing name stops a save, because the stored shape needs one); Publish runs the full check
// and says what is wrong. A published template shows read-only with "Revise to edit". Arabic text keeps its direction (dir="auto").
import { useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CYCLE_ANCHOR_KINDS, type CycleAnchorKind, type CycleTemplate } from '@ams/shared';
import { confirmDialog } from '../../../components/confirm-dialog';
import { ReadOnlyNote } from '../../../components/read-only-note';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { useTranslation } from '../../../i18n';
import { defaultCyclesApi, type CyclesApi } from '../../../lib/cycles-api';
import { ApiError } from '../../../lib/framework-api';
import { can, useMe } from '../../../lib/me';
import { defaultSettingsApi, type SettingsApi } from '../../../lib/settings-api';
import { adoptKeys, check, fromDefs, move, newStage, removeStage, snapshot, toDefs, type EStage, type Problem } from './editor-model';
import { anchorLabels, problemText, statusLabels, type T } from './labels';
import { StageCard } from './stage-card';
import { StageTimeline } from './stage-timeline';

interface Notice { kind: 'ok' | 'error' | 'info'; text: string; issues?: string[] }
const control = 'w-full rounded-md border border-border bg-background px-3 py-2 text-sm disabled:opacity-60';
const labelCls = 'flex min-w-0 flex-col gap-1 text-xs text-muted-foreground';

export function TemplateEditorPage({ templateId, api = defaultCyclesApi, settingsApi = defaultSettingsApi, onBack }: {
  templateId: string; api?: CyclesApi; settingsApi?: SettingsApi; onBack: () => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['cycle-template', templateId], queryFn: () => api.template(templateId) });
  const me = useMe(settingsApi);
  // Messages outlive the editor's remount when a template changes status (published, revised).
  const [notice, setNotice] = useState<Notice | null>(null);
  if (q.isLoading || me.isLoading) return <p className="text-sm text-muted-foreground">{t('common.loading')}</p>;
  if (q.isError || !q.data) {
    return (
      <div className="space-y-3">
        <p role="alert" className="text-sm text-red-700">{(q.error as Error | null)?.message ?? t('qmt.loadFailed')}</p>
        <Button type="button" variant="outline" onClick={onBack}>{t('qmt.back')}</Button>
      </div>
    );
  }
  const template = q.data;
  const changed = (next: CycleTemplate) => {
    qc.setQueryData(['cycle-template', next.id], next);
    void qc.invalidateQueries({ queryKey: ['cycle-templates'] });
  };
  return (
    <Editor key={`${template.id}:${template.status}:${template.version}`} template={template} canManage={can(me.data, 'cycle:manage')} api={api}
      notice={notice} setNotice={setNotice} onChanged={changed} onBack={onBack} />
  );
}

function Editor({ template, canManage, api, notice, setNotice, onChanged, onBack }: {
  template: CycleTemplate; canManage: boolean; api: CyclesApi; notice: Notice | null; setNotice: (n: Notice | null) => void;
  onChanged: (t: CycleTemplate) => void; onBack: () => void;
}) {
  const { t: tr } = useTranslation();
  const t = tr as unknown as T;
  const editable = canManage && template.status === 'draft';
  const [name, setName] = useState(template.name);
  const [nameAr, setNameAr] = useState(template.nameAr ?? '');
  const [description, setDescription] = useState(template.description ?? '');
  const [anchors, setAnchors] = useState<CycleAnchorKind[]>(template.anchorKinds);
  const [stages, setStages] = useState<EStage[]>(() => fromDefs(template.stages));
  const [open, setOpen] = useState<Set<string>>(() => new Set(editable ? stages.slice(0, 1).map((s) => s.uid) : stages.map((s) => s.uid)));
  const [base, setBase] = useState(() => snapshot({ name: template.name, nameAr: template.nameAr ?? '', description: template.description ?? '', anchorKinds: template.anchorKinds }, fromDefs(template.stages)));
  const [busy, setBusy] = useState(false);
  const summary = useRef<HTMLElement>(null);

  const head = { name, nameAr, description, anchorKinds: anchors };
  const problems = useMemo(() => check({ name }, stages), [name, stages]);
  const blocking = problems.filter((p) => p.level !== 'note');
  const saveBlockers = problems.filter((p) => p.level === 'save');
  const dirty = snapshot(head, stages) !== base;
  const forStage = (i: number): Problem[] => problems.filter((p) => p.stage === i);

  const toggle = (uid: string) => setOpen((s) => { const n = new Set(s); if (n.has(uid)) n.delete(uid); else n.add(uid); return n; });
  const jump = (p: Problem) => {
    if (p.stage === null) { summary.current?.scrollIntoView?.({ block: 'nearest' }); return; }
    const s = stages[p.stage];
    if (!s) return;
    setOpen((o) => new Set(o).add(s.uid));
    setTimeout(() => document.getElementById(`stage-${s.uid}`)?.scrollIntoView?.({ block: 'center' }), 0);
  };

  const errorOf = (e: unknown): Notice => (e instanceof ApiError
    ? { kind: 'error', text: e.message, ...(e.issues.length ? { issues: e.issues.map((i) => i.message) } : {}) }
    : { kind: 'error', text: (e as Error).message });

  /** Saves the draft as it is (unfinished is fine); false when the stored shape cannot hold it yet or the save failed. */
  const save = async (): Promise<boolean> => {
    if (saveBlockers.length) { setNotice({ kind: 'error', text: t('qmt.save.blocked'), issues: saveBlockers.map((p) => problemText(t, p)) }); return false; }
    try {
      const saved = await api.updateTemplate(template.id, {
        name: name.trim(), nameAr: nameAr.trim() || null, description: description.trim() || null, anchorKinds: anchors, stages: toDefs(stages, 'save'),
      });
      const adopted = adoptKeys(stages, saved.stages);
      setStages(adopted);
      setBase(snapshot(head, adopted));
      onChanged(saved);
      return true;
    } catch (e) { setNotice(errorOf(e)); return false; }
  };
  const onSave = async () => { setBusy(true); setNotice(null); try { if (await save()) setNotice({ kind: 'ok', text: t('qmt.save.done') }); } finally { setBusy(false); } };

  const onPublish = async () => {
    setNotice(null);
    if (blocking.length) {
      setNotice({ kind: 'error', text: t('qmt.publish.blocked', { count: blocking.length }), issues: blocking.map((p) => problemText(t, p)) });
      summary.current?.scrollIntoView?.({ block: 'nearest' });
      return;
    }
    setBusy(true);
    try {
      if (dirty && !(await save())) return;
      const published = await api.publishTemplate(template.id);
      onChanged(published);
      setNotice({ kind: 'ok', text: t('qmt.publish.done', { version: published.version }) });
    } catch (e) { setNotice(errorOf(e)); } finally { setBusy(false); }
  };

  const onRevise = async () => {
    setBusy(true); setNotice(null);
    try {
      const draft = await api.reviseTemplate(template.id);
      onChanged(draft);
      setNotice({ kind: 'info', text: t('qmt.revise.done', { version: template.version + 1 }) });
    } catch (e) { setNotice(errorOf(e)); } finally { setBusy(false); }
  };

  const onBackClick = async () => {
    if (dirty && !(await confirmDialog({ title: t('qmt.discard.title'), message: t('qmt.discard.message'), confirmLabel: t('qmt.discard.confirm'), tone: 'danger' }))) return;
    onBack();
  };

  const addStage = () => {
    const s = newStage(t('qmt.stage.newName', { n: stages.length + 1 }), stages[stages.length - 1]);
    setStages([...stages, s]);
    setOpen((o) => new Set(o).add(s.uid));
    setTimeout(() => document.getElementById(`stage-${s.uid}`)?.scrollIntoView?.({ block: 'nearest' }), 0);
  };
  const onStages = (next: EStage[], detached: number) => {
    setStages(next);
    if (detached > 0) setNotice({ kind: 'info', text: t('qmt.detached', { count: detached }) });
  };
  const statuses = statusLabels(t);
  const anchorNames = anchorLabels(t);
  const toggleAnchor = (k: CycleAnchorKind) => setAnchors((a) => (a.includes(k) ? a.filter((x) => x !== k) : [...a, k]));

  return (
    <div className="space-y-5" data-testid="template-editor">
      <div>
        <Button type="button" variant="ghost" className="-ms-3 mb-1" onClick={() => void onBackClick()}>← {t('qmt.back')}</Button>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="min-w-0 break-words text-xl font-semibold" dir="auto">{template.name}</h2>
          <span data-testid="template-status" className="rounded-full bg-muted px-2 py-0.5 text-xs">{statuses[template.status]}</span>
          <span className="text-xs text-muted-foreground">{template.version > 0 ? t('qmt.version', { version: template.version }) : t('qmt.notPublished')}</span>
          {template.origin === 'default' && <span className="rounded-full border border-border px-2 py-0.5 text-xs">{t('qmt.origin.default')}</span>}
        </div>
        {template.nameAr && <p className="text-sm text-muted-foreground" dir="auto">{template.nameAr}</p>}
      </div>

      <ReadOnlyNote show={!canManage} />
      {canManage && template.status !== 'draft' && (
        <div data-testid="published-note" className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-muted p-3 text-sm">
          <p className="min-w-0 flex-1">{template.status === 'published' ? t('qmt.published.note', { version: template.version }) : t('qmt.retired.note', { version: template.version })}</p>
          <Button type="button" disabled={busy} onClick={() => void onRevise()}>{t('qmt.act.reviseToEdit')}</Button>
        </div>
      )}
      {!canManage && template.status !== 'draft' && <p className="text-sm text-muted-foreground">{template.status === 'published' ? t('qmt.published.view', { version: template.version }) : t('qmt.retired.view')}</p>}
      {!canManage && template.status === 'draft' && <p className="text-sm text-muted-foreground">{t('qmt.draft.view')}</p>}

      {notice && (
        <div role={notice.kind === 'error' ? 'alert' : 'status'} data-testid="editor-notice"
          className={`rounded-md border p-3 text-sm ${notice.kind === 'error' ? 'border-red-300 bg-red-50 text-red-900' : notice.kind === 'ok' ? 'border-green-300 bg-green-50 text-green-900' : 'border-border bg-muted'}`}>
          <p>{notice.text}</p>
          {notice.issues && notice.issues.length > 0 && <ul className="mt-1 list-disc space-y-0.5 ps-5">{notice.issues.map((m, i) => <li key={i} dir="auto">{m}</li>)}</ul>}
        </div>
      )}

      <fieldset disabled={!editable} className="m-0 min-w-0 space-y-3 border-0 p-0">
        <legend className="sr-only">{t('qmt.details')}</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className={labelCls}>{t('qmt.f.nameEn')}
            <Input aria-label={t('qmt.f.templateName')} dir="auto" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className={labelCls}>{t('qmt.f.nameAr')}
            <Input aria-label={t('qmt.f.templateNameAr')} dir="auto" value={nameAr} onChange={(e) => setNameAr(e.target.value)} />
          </label>
        </div>
        <label className={labelCls}>{t('qmt.f.description')}
          <textarea aria-label={t('qmt.f.templateDescription')} dir="auto" rows={3} className={control} value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <fieldset className="m-0 min-w-0 border-0 p-0">
          <legend className="mb-1 text-xs text-muted-foreground">{t('qmt.f.anchors')}</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {CYCLE_ANCHOR_KINDS.filter((k) => k === 'evidence_item' || anchors.includes(k)).map((k) => (
              <label key={k} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={anchors.includes(k)} onChange={() => toggleAnchor(k)} />
                {anchorNames[k]}
              </label>
            ))}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{t('qmt.f.anchorsHint')}</p>
        </fieldset>
        <p className="text-xs text-muted-foreground">{t('qmt.f.key', { key: template.key })}</p>
      </fieldset>

      {editable && (
        <section ref={summary} aria-label={t('qmt.check.label')} data-testid="check-summary" className="space-y-2 rounded-md border border-border p-3">
          {blocking.length === 0 ? (
            <p className="text-sm text-green-800">{t('qmt.check.ok')}</p>
          ) : (
            <>
              <h3 className="text-sm font-semibold">{t('qmt.check.title', { count: blocking.length })}</h3>
              <ul className="space-y-1 text-sm">
                {blocking.map((p, i) => (
                  <li key={i}>
                    <button type="button" className="text-start underline decoration-dotted underline-offset-2" dir="auto" onClick={() => jump(p)}>{problemText(t, p)}</button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      <section className="space-y-3" aria-label={t('qmt.stages.label')}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-lg font-semibold">{t('qmt.stages.title', { count: stages.length })}</h3>
          {stages.length > 0 && (
            <span className="flex gap-1">
              <Button type="button" variant="outline" className="px-3 py-1" onClick={() => setOpen(new Set(stages.map((s) => s.uid)))}>{t('qmt.act.expandAll')}</Button>
              <Button type="button" variant="outline" className="px-3 py-1" onClick={() => setOpen(new Set())}>{t('qmt.act.collapseAll')}</Button>
            </span>
          )}
        </div>
        <p className="text-sm text-muted-foreground">{t('qmt.stages.hint')}</p>
        {stages.length === 0 && <p className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">{t('qmt.stages.empty')}</p>}
        <ol className="space-y-3" aria-label={t('qmt.stages.label')}>
          {stages.map((s, i) => (
            <StageCard key={s.uid} stage={s} index={i} stages={stages} editable={editable} open={open.has(s.uid)} problems={editable ? forStage(i) : []}
              onToggle={() => toggle(s.uid)} onChange={(next) => setStages(stages.map((x) => (x.uid === s.uid ? next : x)))}
              onMove={(d) => setStages(move(stages, i, d))}
              onRemove={() => { const r = removeStage(stages, s.uid); onStages(r.stages, r.changed); }} onStages={onStages} />
          ))}
        </ol>
        {editable && <Button type="button" variant="outline" onClick={addStage}>{t('qmt.act.addStage')}</Button>}
      </section>

      <section className="space-y-2" aria-label={t('qmt.timeline.title')}>
        <h3 className="text-lg font-semibold">{t('qmt.timeline.title')}</h3>
        <p className="text-sm text-muted-foreground">{t('qmt.timeline.hint')}</p>
        <StageTimeline stages={stages} />
      </section>

      {editable && (
        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
          <Button type="button" variant="outline" disabled={busy || !dirty} onClick={() => void onSave()}>{t('qmt.act.saveDraft')}</Button>
          <Button type="button" disabled={busy} onClick={() => void onPublish()}>{t('qmt.act.publish')}</Button>
          <span className="text-xs text-muted-foreground" data-testid="save-state">{dirty ? t('qmt.unsaved') : t('qmt.savedState')}</span>
        </div>
      )}
    </div>
  );
}

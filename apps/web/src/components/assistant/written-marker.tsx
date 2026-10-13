import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '../ui/button';
import { ApiError } from '../../lib/framework-api';
import { useAssistantApi, type AssistantApi } from '../../lib/assistant-api';

const FIELD_WORDS: Record<string, string> = { title: 'title', officialText: 'description', translationEn: 'English translation' };

/**
 * "Written by the assistant": shown on a requirement while a text the assistant wrote (and the person confirmed) is still in it and
 * nobody has reviewed it. Keep clears the marker; Revert puts the earlier text back as a normal edit (the toast offers Undo). The
 * marker goes by itself when the text is edited by hand. Publishing stays the gate: unreviewed texts only show as a warning there.
 */
export function WrittenByAssistant({ versionId, requirementId, canWrite, onChanged, api: override }: {
  versionId: string; requirementId: string; canWrite: boolean; onChanged?: () => unknown; api?: AssistantApi;
}) {
  const api = useAssistantApi(override);
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const marks = useQuery({ queryKey: ['assistant-texts', versionId], queryFn: () => api.writtenTexts(versionId), staleTime: 5000, retry: false });
  const mine = (marks.data ?? []).filter((m) => m.requirementId === requirementId);
  if (mine.length === 0) return null;
  const what = mine.map((m) => FIELD_WORDS[m.field] ?? m.field).join(' and ');
  const decide = async (kind: 'keep' | 'revert') => {
    setBusy(true); setError(null);
    try {
      for (const m of mine) await (kind === 'keep' ? api.keepWritten(m.id) : api.revertWritten(m.id));
      await qc.invalidateQueries({ queryKey: ['assistant-texts', versionId] });
      await onChanged?.();
    } catch (e) { setError(e instanceof ApiError ? e.message : 'Could not do that'); } finally { setBusy(false); }
  };
  return (
    <div role="note" data-testid="written-by-assistant" className="flex flex-wrap items-center gap-2 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-950">
      <span className="font-medium">Written by the assistant</span>
      <span>The {what} has not been reviewed yet.</span>
      {canWrite && (
        <span className="ms-auto flex gap-1">
          <Button type="button" variant="outline" className="min-h-8 px-2 py-0.5 text-xs" disabled={busy} onClick={() => void decide('keep')}>Keep</Button>
          <Button type="button" variant="outline" className="min-h-8 px-2 py-0.5 text-xs" disabled={busy} onClick={() => void decide('revert')}>Revert</Button>
        </span>
      )}
      {error && <span role="alert" className="w-full text-red-700">{error}</span>}
    </div>
  );
}

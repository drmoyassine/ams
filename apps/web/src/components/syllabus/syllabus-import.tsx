// Import from, and export to, the syllabus workbook (TASK-126). Importing loads each course as a draft and never refuses a rule: the result
// says, per course, what loaded (with how many errors and warnings it was flagged with) and what was skipped and why.
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { emptyWorkbook } from '@ams/shared';
import { useFilePicker } from '../files';
import { Button } from '../ui/button';
import { errorText } from '../evidence-item-form';
import { download } from '../../lib/sheet-io';
import { readSyllabusWorkbook, writeSyllabusWorkbook } from '../../lib/syllabus-sheets';
import { useSyllabusApi, type SyllabusApi } from '../../lib/syllabus-api';

type Result = Awaited<ReturnType<SyllabusApi['importWorkbook']>>;
const WORDS = { loaded: 'Loaded as a draft', unknown_course: 'Skipped: no such course', not_allowed: 'Skipped: not allowed', in_review: 'Skipped: in review' } as const;

export function SyllabusImport({ api: override }: { api?: SyllabusApi }) {
  const api = useSyllabusApi(override);
  const qc = useQueryClient();
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const picker = useFilePicker({
    kind: 'data', label: 'Syllabus workbook',
    onFiles: ([file]) => {
      if (!file) return;
      setBusy(true); setError(''); setResult(null);
      void readSyllabusWorkbook(file).then((wb) => api.importWorkbook(wb)).then(async (r) => { setResult(r); await qc.invalidateQueries({ queryKey: ['syllabi'] }); await qc.invalidateQueries({ queryKey: ['syllabus'] }); })
        .catch((e: unknown) => setError(errorText(e))).finally(() => setBusy(false));
    },
  });
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" disabled={busy} onClick={picker.open}>{busy ? 'Importing…' : 'Import from Excel'}</Button>
        <Button type="button" variant="ghost" onClick={() => void writeSyllabusWorkbook(emptyWorkbook()).then((b) => download(b, 'syllabus-template.xlsx'))}>Download the Excel template</Button>
        {picker.input}
      </div>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {result && (
        <div role="status" className="space-y-1 rounded-lg border border-border p-3 text-sm" data-testid="import-result">
          <p className="font-medium">{result.loaded} syllabus{result.loaded === 1 ? '' : 'es'} loaded{result.flagged ? `, ${result.flagged} flagged with errors to fix` : ''}.</p>
          <ul className="space-y-0.5 text-xs">
            {result.results.map((r) => (
              <li key={r.courseCode}><span className="font-mono">{r.courseCode}</span>: {WORDS[r.status]}{r.status === 'loaded' ? ` (version ${r.versionNo}, ${r.errors} error${r.errors === 1 ? '' : 's'}, ${r.warnings} warning${r.warnings === 1 ? '' : 's'})` : r.message ? `. ${r.message}` : ''}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// The red bar at the top of every screen while a syllabus that needs YOU has errors (DEC-038): the course coordinator at once, and, as the
// days in the settings pass without a fix, the program chair, the Dean and the VPAA. It stays for as long as an error stands.
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useSyllabusApi, type SyllabusApi } from '../../lib/syllabus-api';

export function SyllabusAlertBar({ enabled, api: override }: { enabled: boolean; api?: SyllabusApi }) {
  const api = useSyllabusApi(override);
  const mine = useQuery({ queryKey: ['syllabi', 'attention'], queryFn: () => api.list({ mine: true }), enabled, staleTime: 30_000, refetchInterval: 120_000, retry: false });
  const rows = mine.data ?? [];
  if (!enabled || rows.length === 0) return null;
  const errors = rows.reduce((n, r) => n + r.errorCount, 0);
  return (
    <div role="alert" data-testid="syllabus-alert-bar" className="sticky top-0 z-30 mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-red-300 bg-red-600 px-4 py-2 text-sm text-white print:hidden">
      <span className="font-medium">{rows.length === 1 ? '1 syllabus has' : `${rows.length} syllabi have`} {errors} error{errors === 1 ? '' : 's'} and need{rows.length === 1 ? 's' : ''} your attention:</span>
      <span className="flex flex-wrap gap-x-3">
        {rows.slice(0, 4).map((r) => (
          <Link key={r.courseId} to="/courses/$id/syllabus" params={{ id: r.courseId }} className="underline underline-offset-2">{r.code} ({r.errorCount})</Link>
        ))}
        {rows.length > 4 && <Link to="/quality-management" search={{ tab: 'syllabi' }} className="underline underline-offset-2">and {rows.length - 4} more</Link>}
      </span>
      <Link to="/quality-management" search={{ tab: 'syllabi' }} className="ms-auto underline underline-offset-2">Open Syllabi</Link>
    </div>
  );
}

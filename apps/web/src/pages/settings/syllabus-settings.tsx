import { useMe, can } from '../../lib/me';
import { SyllabusLimits } from '../../components/syllabus/syllabus-limits';
import { SyllabusTemplateEditor } from '../../components/syllabus/syllabus-template-editor';
import { useSettingsApi, type SettingsApi } from '../../lib/settings-api';

/** Settings -> Organization -> Syllabus rules: how big a syllabus may be, who is told when it has errors, and (behind "advanced") the form's sections. */
export function SyllabusSettingsPage({ api: override }: { api?: SettingsApi }) {
  const api = useSettingsApi(override);
  const me = useMe(api);
  const canWrite = can(me.data, 'org:write');
  return (
    <div className="max-w-3xl space-y-4">
      <div>
        <h3 className="text-lg font-semibold">Syllabus rules</h3>
        <p className="text-sm text-muted-foreground">These rules apply to every course syllabus. A syllabus that breaks one is still saved, but it is flagged in red until it is fixed.</p>
      </div>
      <SyllabusLimits canWrite={canWrite} />
      <SyllabusTemplateEditor canWrite={canWrite} />
    </div>
  );
}

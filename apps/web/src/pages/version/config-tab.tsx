import { useQueryClient } from '@tanstack/react-query';
import { JsonEditor } from '../../components/json-editor';
import type { FrameworkApi, Version } from '../../lib/framework-api';
import { can } from '../../lib/me';
import { FoundBy, foundOf, wasEdited } from './found-by';
import type { Me } from '@ams/shared';

/** `section` is the name the database and the analysis use for the part (framework_version.config_found / config_edited). */
const FIELDS: { key: keyof Version; patch: string; label: string; section?: string }[] = [
  { key: 'levelLabels', patch: 'levelLabels', label: 'Level labels' },
  { key: 'lifecycleTemplate', patch: 'lifecycleTemplate', label: 'Lifecycle template', section: 'lifecycle_template' },
  { key: 'decisionVocab', patch: 'decisionVocab', label: 'Decision vocabulary', section: 'decision_vocab' },
  { key: 'findingVocab', patch: 'findingVocab', label: 'Finding vocabulary', section: 'finding_vocab' },
  { key: 'responseVocab', patch: 'responseVocab', label: 'Response vocabulary', section: 'response_vocab' },
  { key: 'ratingMethod', patch: 'ratingMethod', label: 'Rating method (optional)', section: 'rating_method' },
];

/** Lifecycle, vocabularies and the rest of a version's configuration, edited as JSON and validated by the server. */
export function ConfigTab({ api, version, me }: { api: FrameworkApi; version: Version; me: Me | undefined }) {
  const qc = useQueryClient();
  const editable = version.status === 'draft' && can(me, 'framework:write');
  return (
    <div className="space-y-8">
      {!editable && <p className="text-sm text-muted-foreground">This version is {version.status.replace('_', ' ')}; configuration is read-only. Create a new version to change it.</p>}
      {FIELDS.map((f) => (
        <div key={f.patch} className="space-y-2">
          {f.section && <FoundBy label={f.label} found={foundOf(version.configFound, f.section)} edited={wasEdited(version.configEdited, f.section)} />}
          <JsonEditor
            label={f.label} value={version[f.key]} readOnly={!editable} rows={f.patch === 'lifecycleTemplate' ? 24 : 8}
            onSave={async (parsed) => {
              await api.patchConfig(version.id, { [f.patch]: parsed });
              await qc.invalidateQueries({ queryKey: ['version', version.id] });
              await qc.invalidateQueries({ queryKey: ['validation', version.id] });
            }}
          />
        </div>
      ))}
    </div>
  );
}

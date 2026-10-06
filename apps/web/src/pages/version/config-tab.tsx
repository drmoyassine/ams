import { useQueryClient } from '@tanstack/react-query';
import { JsonEditor } from '../../components/json-editor';
import type { FrameworkApi, Version } from '../../lib/framework-api';
import { can } from '../../lib/me';
import type { Me } from '@ams/shared';

const FIELDS: { key: keyof Version; patch: string; label: string }[] = [
  { key: 'levelLabels', patch: 'levelLabels', label: 'Level labels' },
  { key: 'lifecycleTemplate', patch: 'lifecycleTemplate', label: 'Lifecycle template' },
  { key: 'decisionVocab', patch: 'decisionVocab', label: 'Decision vocabulary' },
  { key: 'findingVocab', patch: 'findingVocab', label: 'Finding vocabulary' },
  { key: 'responseVocab', patch: 'responseVocab', label: 'Response vocabulary' },
  { key: 'ratingMethod', patch: 'ratingMethod', label: 'Rating method (optional)' },
];

/** Lifecycle, vocabularies and the rest of a version's configuration, edited as JSON and validated by the server. */
export function ConfigTab({ api, version, me }: { api: FrameworkApi; version: Version; me: Me | undefined }) {
  // The institution's own framework has no accreditor lifecycle or vocabularies: only the names of its levels.
  const fields = version.internal ? FIELDS.filter((f) => f.key === 'levelLabels') : FIELDS;
  const qc = useQueryClient();
  const editable = version.status === 'draft' && can(me, 'framework:write');
  return (
    <div className="space-y-8">
      {!editable && <p className="text-sm text-muted-foreground">This version is {version.status.replace('_', ' ')}; configuration is read-only. Create a new version to change it.</p>}
      {fields.map((f) => (
        <JsonEditor
          key={f.patch} label={f.label} value={version[f.key]} readOnly={!editable} rows={f.patch === 'lifecycleTemplate' ? 24 : 8}
          onSave={async (parsed) => {
            await api.patchConfig(version.id, { [f.patch]: parsed });
            await qc.invalidateQueries({ queryKey: ['version', version.id] });
            await qc.invalidateQueries({ queryKey: ['validation', version.id] });
          }}
        />
      ))}
    </div>
  );
}

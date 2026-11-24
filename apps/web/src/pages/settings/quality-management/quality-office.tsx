// The QA office (DEC-048): the unit whose head and members take the QA office step of every approval chain, right before the champion.
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Card } from '../../../components/ui/card';
import { can, useMe } from '../../../lib/me';
import { useQualityApi, type QualityApi } from '../../../lib/quality-api';
import { useSettingsApi, type SettingsApi } from '../../../lib/settings-api';
import { useAction } from '../../../lib/use-action';

export function QualityOfficeCard({ api: override, settings: settingsOverride }: { api?: QualityApi; settings?: SettingsApi }) {
  const api = useQualityApi(override);
  const sapi = useSettingsApi(settingsOverride);
  const me = useMe(sapi);
  const qc = useQueryClient();
  const office = useQuery({ queryKey: ['quality-office'], queryFn: () => api.office() });
  const units = useQuery({ queryKey: ['org-units'], queryFn: () => sapi.orgUnits() });
  const [error, setError] = useState<string | null>(null);
  const act = useAction(setError);
  const canWrite = can(me.data, 'org:write');
  // Only what the API answered as a list and a unit id counts (a failed or odd answer shows an empty choice, never breaks the page).
  const unitList = Array.isArray(units.data) ? units.data : [];
  const officeId = office.data && typeof office.data.unitId === 'string' ? office.data.unitId : '';
  return (
    <Card>
      <section aria-label="QA office" className="space-y-2">
        <h3 className="text-base font-semibold">QA office</h3>
        <p className="text-sm text-muted-foreground">The unit whose head and members approve every Quality Management submission right before the standard&apos;s champion. Its members are the people with a role in it.</p>
        <select aria-label="QA office unit" className="h-9 w-full max-w-md rounded-md border border-border bg-background px-2 text-sm" disabled={!canWrite || !office.data}
          value={officeId} onChange={(e) => { const v = e.target.value || null; void act(() => api.setOffice(v)).then((r) => { if (r) void qc.invalidateQueries({ queryKey: ['quality-office'] }); }); }}>
          <option value="">Not named</option>
          {unitList.filter((u) => u.active).sort((a, b) => a.nameEn.localeCompare(b.nameEn)).map((u) => <option key={u.id} value={u.id}>{u.nameEn}</option>)}
        </select>
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      </section>
    </Card>
  );
}

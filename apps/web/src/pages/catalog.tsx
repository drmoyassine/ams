// The generated catalog (DEC-046, step 5): /catalog/<version id> for a published version, /catalog/draft for the draft, optionally ?program=<code>
// for one program's catalog. On screen, printed or saved as PDF, and downloaded for Word. Read-only: it is all generated from the snapshot.
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { renderToStaticMarkup } from 'react-dom/server';
import { CatalogDocument, CATALOG_CSS } from '../components/catalog/catalog-document';
import { Button } from '../components/ui/button';
import { useCatalogApi, type CatalogApi } from '../lib/catalog-api';
import { download } from '../lib/sheet-io';
import { useUrlState } from '../lib/url-state';

/** The Word file: the same document as HTML that Word opens (the registrar typesets from it). */
export function catalogWordBlob(markup: string): Blob {
  const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40"><head><meta charset="utf-8"><title>Catalog</title><style>${CATALOG_CSS}</style></head><body>${markup}</body></html>`;
  return new Blob(['﻿', html], { type: 'application/msword' });
}

export function CatalogPage({ versionId, catalog: override }: { versionId: string; catalog?: CatalogApi }) {
  const api = useCatalogApi(override);
  const [program, setProgram] = useUrlState<string>('program', '');
  const draft = versionId === 'draft';
  const q = useQuery({
    queryKey: ['catalog-doc', versionId],
    queryFn: async () => {
      if (draft) return { snapshot: await api.preview(), editionLabel: 'Draft', versionNo: null as number | null, publishedAt: null as string | null };
      const v = await api.version(versionId);
      return { snapshot: v.snapshot, editionLabel: v.editionLabel, versionNo: v.versionNo as number | null, publishedAt: v.publishedAt as string | null };
    },
  });
  if (q.isError) return <p role="alert" className="text-sm text-red-700">Could not load the catalog.</p>;
  if (!q.data) return <p className="text-sm text-muted-foreground">Generating the catalog…</p>;
  const { snapshot, editionLabel, versionNo, publishedAt } = q.data;
  const meta = { editionLabel, versionNo, publishedAt };
  const name = `${snapshot.institution.nameEn} catalog ${editionLabel}${versionNo ? ` v${versionNo}` : ' draft'}${program ? ` ${program}` : ''}`;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 print:hidden">
        <Link to="/settings/organization" search={{ tab: 'catalog' }} className="text-sm underline underline-offset-2">‹ Catalog editions</Link>
        <label className="flex items-center gap-2 text-sm">Show
          <select aria-label="Catalog scope" className="h-9 rounded-md border border-border bg-background px-2 text-sm" value={program} onChange={(e) => setProgram(e.target.value)}>
            <option value="">The whole catalog</option>
            {snapshot.programs.map((p) => <option key={p.code} value={p.code}>{p.code} · {p.nameEn}</option>)}
          </select>
        </label>
        <Button type="button" variant="outline" className="ms-auto" onClick={() => window.print()}>Print or save as PDF</Button>
        <Button type="button" variant="outline" onClick={() => download(catalogWordBlob(renderToStaticMarkup(<CatalogDocument snapshot={snapshot} meta={meta} program={program || null} />)), `${name}.doc`)}>Download for Word</Button>
      </div>
      {draft && <p role="note" className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950 print:hidden">This is the draft: what the next version would hold. Publish a version to freeze it.</p>}
      <style>{CATALOG_CSS}</style>
      <CatalogDocument snapshot={snapshot} meta={meta} program={program || null} />
    </div>
  );
}

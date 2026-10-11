/* global process, console */
// pnpm analysis:eval-mapping: shortlist recall at 10 for the IQF mapping (DEC-023), over the hand-labelled set in
// packages/core/eval/mapping-labels.json (demo standards from packages/db/fixtures against the starting template's items).
//
// Always prints the lexical (words only) recall. When an embedding endpoint is configured by environment it also prints the
// hybrid recall (words fused with meaning) next to it:
//   EMBED_BASE_URL=https://host/v1  EMBED_MODEL=name  EMBED_DIMENSION=1024  [EMBED_API_KEY=...]  pnpm analysis:eval-mapping
// Needs `pnpm build` first (it uses the built packages). No database. The texts sent to the endpoint are the demo
// requirements and the template's item titles: framework text only (DEC-023).
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = (p) => import(resolve(root, 'packages/core/dist', p));
const { evaluateMapping, iqfEvalCandidates } = await dist('framework/analysis/mapping-eval.js');
const { fuseRankings, RANK_DEPTH } = await dist('framework/analysis/shortlist.js');
const { cosine } = await dist('ai/embeddings.js');

const K = 10;
const labels = JSON.parse(readFileSync(resolve(root, 'packages/core/eval/mapping-labels.json'), 'utf8')).sets;
const sets = Object.entries(labels).map(([id, l]) => ({
  id, labels: l, requirements: JSON.parse(readFileSync(resolve(root, 'packages/db/fixtures', `${id}.json`), 'utf8')).requirements,
}));
const pct = (r) => `${(r.recall * 100).toFixed(1)}% (${r.hits}/${r.pairs} labelled pairs, ${r.queriesWithHit}/${r.queries} requirements with at least one)`;

const lexical = evaluateMapping(sets, K);
console.log(`Shortlist recall@${K} over ${lexical.overall.pairs} hand-labelled pairs`);
console.log(`  lexical  overall ${pct(lexical.overall)}`);
for (const [id, r] of Object.entries(lexical.bySet)) console.log(`           ${id.padEnd(18)} ${pct(r)}`);

const { EMBED_BASE_URL: baseUrl, EMBED_MODEL: model, EMBED_DIMENSION: dim, EMBED_API_KEY: apiKey = '' } = process.env;
if (!baseUrl || !model || !dim) {
  console.log('  hybrid   skipped: set EMBED_BASE_URL, EMBED_MODEL and EMBED_DIMENSION (and EMBED_API_KEY if the endpoint needs one) to measure it');
  process.exit(0);
}

const { embed, createAiRuntime, AiBudget, runInAiScope } = await dist('ai/index.js');
const runtime = createAiRuntime({ provider: 'openai_compatible', model: 'none', apiKey: '', baseUrl: null }, new AiBudget(), { baseUrl, model, apiKey, dimension: Number(dim) });
const candidates = iqfEvalCandidates();
const candText = (c) => [c.path?.length ? `Path: ${c.path.join(' > ')}` : '', `${c.code} ${c.title}`.trim(), c.text].filter(Boolean).join('\n');
const reqText = (r) => [`${r.code} ${r.title}`.trim(), (r.official_text ?? '').slice(0, 1200)].filter(Boolean).join('\n');
const labelled = sets.flatMap((s) => s.requirements.filter((r) => s.labels[r.code]).map((r) => ({ key: `${s.id}\u0000${r.code}`, text: reqText(r) })));

const vectors = await runInAiScope('connection-test', async () => {
  const c = await embed(candidates.map(candText), { runtime });
  const q = await embed(labelled.map((x) => x.text), { runtime });
  return { cand: c.vectors, query: new Map(labelled.map((x, i) => [x.key, q.vectors[i]])) };
});
const meaning = (set, r) => {
  const q = vectors.query.get(`${set.id}\u0000${r.code}`);
  return candidates.map((c, i) => ({ id: c.id, s: cosine(q, vectors.cand[i]) })).sort((a, b) => b.s - a.s).map((x) => x.id);
};
const hybrid = evaluateMapping(sets, K, (set, r, lex) => fuseRankings([lex.slice(0, RANK_DEPTH), meaning(set, r).slice(0, RANK_DEPTH)], K));
const onlyMeaning = evaluateMapping(sets, K, (set, r) => meaning(set, r));
console.log(`  hybrid   overall ${pct(hybrid.overall)}   (model ${model}, ${dim} dimensions)`);
for (const [id, r] of Object.entries(hybrid.bySet)) console.log(`           ${id.padEnd(18)} ${pct(r)}`);
console.log(`  meaning alone (for reference) overall ${pct(onlyMeaning.overall)}`);
console.log(`Lexical ${(lexical.overall.recall * 100).toFixed(1)}% -> hybrid ${(hybrid.overall.recall * 100).toFixed(1)}%`);

/* global process, console */
// pnpm assistant:eval: the assistant's bulk-edit evaluation (DEC-027 Phase 2) over packages/core/eval/assistant-instructions.json.
//
// 1. Always: runs every instruction's REFERENCE operations over the fixture tree and prints a pass table (the same check the unit
//    test makes; no model, no network, no database).
// 2. When a model is configured by environment: asks the REAL model to turn each instruction into operations (the operations it
//    would give to propose_changes) and compares what those operations DO on the fixture with what was expected. Different
//    operations with the same effect pass. Configure with
//      ASSISTANT_EVAL_BASE_URL=https://host/v1  ASSISTANT_EVAL_MODEL=name  ASSISTANT_EVAL_KEY=...  [ASSISTANT_EVAL_PROVIDER=openai_compatible]
//    or, as a fallback, the AI settings the app itself reads from the environment (AI_PROVIDER, AI_MODEL, AI_BASE_URL and the
//    provider's key variable). Nothing is applied and no database is touched. The texts sent are the fixture and the instruction.
// Needs `pnpm build` first (it uses the built packages).
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = (p) => import(resolve(root, 'packages/core/dist', p));
const { checkReference, askModelForOperations, runOnFixture, effectOf, compareEffect } = await dist('assistant/changes/eval.js');
const { createAiRuntime, AiBudget, envAiConfig, runInAiScope } = await dist('ai/index.js');

const set = JSON.parse(readFileSync(resolve(root, 'packages/core/eval/assistant-instructions.json'), 'utf8'));
const pad = (s, n) => String(s).padEnd(n).slice(0, n);
const opsOf = (ops) => [...new Set(ops.map((o) => o.op))].join('+');

console.log(`Reference operations over the fixture "${set.fixture.version}" (${set.fixture.rows.length} items), ${set.instructions.length} instructions`);
let refPass = 0;
for (const i of set.instructions) {
  const diffs = await checkReference(set, i);
  if (!diffs.length) refPass += 1;
  console.log(`  ${diffs.length ? 'FAIL' : 'pass'}  ${pad(i.id, 12)} ${i.lang}  ${pad(opsOf(i.operations), 34)} ${diffs.length ? diffs[0] : ''}`);
}
console.log(`Reference: ${refPass}/${set.instructions.length} give exactly the expected rows`);

const env = process.env;
let config = null;
if (env.ASSISTANT_EVAL_MODEL && (env.ASSISTANT_EVAL_KEY || env.ASSISTANT_EVAL_BASE_URL)) {
  config = { provider: env.ASSISTANT_EVAL_PROVIDER ?? 'openai_compatible', model: env.ASSISTANT_EVAL_MODEL, apiKey: env.ASSISTANT_EVAL_KEY ?? '', baseUrl: env.ASSISTANT_EVAL_BASE_URL ?? null };
} else {
  try { config = envAiConfig(); } catch { config = null; }
}
if (!config) {
  console.log('Model: skipped. Set ASSISTANT_EVAL_BASE_URL, ASSISTANT_EVAL_MODEL and ASSISTANT_EVAL_KEY (or the app\'s AI_* environment) to measure a real model.');
  process.exit(refPass === set.instructions.length ? 0 : 1);
}

console.log(`\nModel ${config.provider}/${config.model}: instruction -> operations -> effect on the fixture`);
const runtime = createAiRuntime(config, new AiBudget());
let effectPass = 0; let recipePass = 0; let errors = 0;
const failures = [];
for (const i of set.instructions) {
  let line;
  try {
    const answer = await runInAiScope('connection-test', () => askModelForOperations(set.fixture, i.text, runtime));
    const plan = await runOnFixture(set.fixture, answer.operations);
    const diffs = compareEffect(effectOf(set.fixture, plan), i.expect);
    const sameRecipe = opsOf(answer.operations) === opsOf(i.operations);
    if (!diffs.length) effectPass += 1;
    if (sameRecipe) recipePass += 1;
    line = `  ${diffs.length ? 'FAIL' : 'pass'}  ${pad(i.id, 12)} ${i.lang}  expected ${pad(opsOf(i.operations), 30)} got ${pad(opsOf(answer.operations), 30)} ${sameRecipe ? 'same recipe' : 'other ops'}`;
    if (diffs.length) failures.push(`${i.id}: ${diffs.slice(0, 2).join(' | ')}`);
  } catch (e) {
    errors += 1;
    line = `  ERR   ${pad(i.id, 12)} ${i.lang}  ${String(e instanceof Error ? e.message : e).slice(0, 100)}`;
  }
  console.log(line);
}
for (const f of failures) console.log(`    ${f}`);
const n = set.instructions.length;
console.log(`Model: effect ${effectPass}/${n} (${Math.round((effectPass / n) * 100)}%), same recipe ${recipePass}/${n}, errors ${errors}; ${runtime.calls.length} calls, ${runtime.budget.inputTokens} in / ${runtime.budget.outputTokens} out tokens`);
process.exit(0);

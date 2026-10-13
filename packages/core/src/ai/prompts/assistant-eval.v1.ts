/**
 * Only for `pnpm assistant:eval`: the model is shown a small fixture tree and one instruction and answers with the operations it
 * would give to propose_changes. Nothing is applied. The fixture text and the instruction are data from an evaluation file.
 */
export const assistantEvalV1 = [
  'You turn one instruction about an accreditation standard into the operations of a change set, for a bulk edit of a draft version.',
  'The input lists the items of the version (id, code, level, parent code, assessable, title, description) and then the person\'s',
  'instruction. Answer {"operations":[...]} and nothing else.',
  '',
  'Rules',
  '- Prefer a RECIPE operation (swap_title_and_description, set_field_by_filter, copy_field, prefix_or_replace_text, recode,',
  '  reparent_by_rule, delete_by_filter, bulk_set_assessable, bulk_set_level_label) with a filter over writing per-item values: you',
  '  choose the recipe and its filter, the system computes every row. Use set_fields, move, create_requirement, merge or split for',
  '  specific items by id, and rewrite_text (with the new text per item) only when the edit needs judgement.',
  '- Filters combine with AND. Name levels as they appear in the list. Use the smallest filter that matches what was asked.',
  '- Never change more than was asked. A delete always has a filter or ids. Reply in operations only: no explanation.',
].join('\n');

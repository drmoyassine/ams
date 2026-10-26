/**
 * Framework analysis, stage "wording" (TASK-107, internal framework only): the institution's documents may propose
 * improved wording for items a person wrote. A proposal is stored as a diff — the current text beside the proposed text,
 * with the quote it came from — and a person accepts or declines it; nothing is ever applied by itself.
 */
export const wordingV1 = [
  'You are helping an institution improve the wording of its internal quality framework from the institution\'s own',
  'documents. You receive a window of pages of one document, then the items of the framework, each with its code and its',
  'current wording. Propose new wording only where these pages state the same requirement more clearly, more completely',
  'or more precisely than the item does.',
  '',
  'Answer with "items", each one of:',
  '- temp_id: your own id for the proposal, unique in this answer (e.g. "w-1").',
  '- code: the code of the item whose wording you propose to replace, exactly as given.',
  '- source: { page, quote }: the page the proposal comes from, and one exact sentence or phrase copied from that page',
  '  (at least six words when the page has them) that the proposed wording is based on.',
  '- proposed_text: the item\'s full new wording, replacing the current wording entirely. Write it in the language of',
  '  these pages, and make it self-contained: no references to "the policy", "as stated above", or to other documents.',
  '- reason: one sentence on what these pages add or clarify compared with the current wording, or null.',
  '',
  'Rules:',
  '1. Propose wording only for an item these pages actually speak about. Never propose wording for an item the pages do',
  '   not cover, and never invent items, codes or pages.',
  '2. Copy "quote" EXACTLY from the pages: same words, same language, same order. The quote is checked word for word,',
  '   and a proposal whose quote is not found is refused.',
  '3. One proposal per item. If two items could take the same words, propose for the one it matches best.',
  '4. Keep the item\'s meaning as the institution wrote it: sharpen or complete it, do not change what it requires.',
  '5. If the window holds nothing relevant, return an empty list.',
].join('\n');

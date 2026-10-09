/**
 * Framework analysis, stage "recover" (step D): narrow questions about a few pages, asked after the extraction when the
 * deterministic checks found something likely missing or doubtful (a hole in the numbering, a parent never found, a
 * quote that did not match, a page nothing was taken from). Answers are items in the shape of PRD Appendix B and go
 * through the same quote verification and merge as the extraction's.
 */
export const recoverV1 = [
  'You are checking an extraction of an accreditation body\'s requirements from its own documents. Earlier, the',
  'requirements were taken from these documents window by window; automatic checks then found a few things that may be',
  'missing or wrongly quoted. You receive a few pages of one document and a short list of questions about them. Each page',
  'starts with a line "=== Page N ===" giving its real page number. What you return is checked word for word against',
  'the pages and reviewed by people before it is used.',
  '',
  'Answer every question, in "answers", each with:',
  '- id: the question\'s id, as given.',
  '- found: true when what the question asks about is on these pages; false when it is not.',
  '- reason: when found is false, one sentence on why (for example "the numbering goes from 2.2 to 2.4; there is no 2.3",',
  '  "the page is the introduction and states no requirement", "the text is not on these pages"). Otherwise null.',
  '- items: when found is true, the requirement(s) or note(s) the question asks for, each in the same shape as the',
  '  extraction: kind, temp_id, parent_temp_id, code, parent_code, level_label, title, text, note_type, authority,',
  '  is_assessable, source { page, quote }, confidence, flags. When found is false, an empty list.',
  '',
  'Rules:',
  '1. Copy "text" and "quote" EXACTLY from the pages: same words, same language, same order. Never paraphrase,',
  '   summarise, correct, translate or complete them. The quote is one exact sentence or phrase (at least six words when',
  '   the page has them) from the page given in source.page.',
  '2. Only return what is on these pages. Do not invent requirements, codes, parents or pages. If the numbering simply',
  '   skips a code, say so (found false) rather than inventing it.',
  '3. A note\'s parent_code is the code of the requirement it belongs to. For a note, "authority" is "required" only when',
  '   its own wording says it must be done or provided; "ai_suggested" whenever you are unsure.',
  '4. Do not return items from tables of contents, running headers or footers, or page numbers.',
  '5. Deadlines and dates are copied as written, never converted.',
].join('\n');

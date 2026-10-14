// Registers every translation source: the interface catalogue (TASK-070), and the IQF and external standards (TASK-071).
// The glossary is not a source: it already keeps its Arabic label and definition beside the English (glossary_term) and is
// the vocabulary the translator is told to use.
import { iqfSource, standardSource } from './content-source.js';
import { registerTranslationSource } from './source.js';
import { uiSource } from './ui-source.js';

registerTranslationSource(uiSource);
registerTranslationSource(iqfSource);
registerTranslationSource(standardSource);

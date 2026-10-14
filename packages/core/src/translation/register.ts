// Registers every translation source. TASK-071 adds its content kinds here (requirements, notes, glossary...).
import { registerTranslationSource } from './source.js';
import { uiSource } from './ui-source.js';

registerTranslationSource(uiSource);

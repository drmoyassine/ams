import { expect, it } from 'vitest';
import { PACKAGE } from './index.js';

it('workspace wiring', () => expect(PACKAGE).toBe('@ams/shared'));

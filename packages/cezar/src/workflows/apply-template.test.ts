import { describe, expect, it } from 'vitest';
import { applyTemplate } from './run.ts';

describe('applyTemplate', () => {
  it('inserts the task verbatim, `$` replacement patterns included', () => {
    const task = "price $& and $' and $` and $$ and $1";
    expect(applyTemplate('Do: {{task}} / again: {{task}}', task)).toBe(`Do: ${task} / again: ${task}`);
  });
});

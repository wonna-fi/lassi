import { describe, expect, it } from 'vitest';
import { labelUpdate, planLabelChange } from './labels.js';

describe('planLabelChange', () => {
  it('deduplicates exact names, preserves case and input order, and leaves literals intact', () => {
    const requested = ['backend', 'Backend', 'backend', 'a,b', '["json"]', 'present', 'present'];
    expect(planLabelChange('add', requested, ['backend', 'present'])).toEqual({
      changed: ['Backend', 'a,b', '["json"]'],
      unchanged: ['backend', 'present'],
    });
    expect(planLabelChange('remove', requested, ['backend', 'present'])).toEqual({
      changed: ['backend', 'present'],
      unchanged: ['Backend', 'a,b', '["json"]'],
    });
  });

  it('adds to an empty issue and treats removal from one as unchanged', () => {
    expect(planLabelChange('add', ['new'], [])).toEqual({ changed: ['new'], unchanged: [] });
    expect(planLabelChange('remove', ['missing'], [])).toEqual({
      changed: [],
      unchanged: ['missing'],
    });
  });

  it.each([
    '',
    'two words',
    ' leading',
    'trailing ',
    'tab\tlabel',
    'line\nlabel',
    'nonbreaking\u00a0space',
  ])('rejects the entire plan for invalid label %j', (label) => {
    for (const mode of ['add', 'remove'] as const) {
      expect(() => planLabelChange(mode, ['valid', label], ['valid'])).toThrow(
        expect.objectContaining({
          code: 'usage',
          message: expect.stringContaining('invalid label'),
        })
      );
    }
  });
});

describe('labelUpdate', () => {
  it('builds additive and removal operations instead of replacing the field', () => {
    expect(labelUpdate('add', ['backend', 'needs-review'])).toEqual({
      update: { labels: [{ add: 'backend' }, { add: 'needs-review' }] },
    });
    expect(labelUpdate('remove', ['backend', 'needs-review'])).toEqual({
      update: { labels: [{ remove: 'backend' }, { remove: 'needs-review' }] },
    });
  });
});

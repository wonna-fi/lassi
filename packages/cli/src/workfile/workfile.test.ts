import { memFs } from '@wonna/lassi-core/testing';
import { describe, expect, it } from 'vitest';
import { diffEditable, readonlyDrift } from './diff.js';
import { lassiDirs } from './paths.js';
import { readWorkingFile } from './read.js';
import { splitEditable } from './schema.js';
import { writeWorkingFile } from './write.js';

describe('working files', () => {
  it('lays out .lassi directories per', () => {
    const dirs = lassiDirs('/w', { attachments: { dir: './.lassi', maxSizeMb: 50 } } as never);
    expect(dirs.work).toBe('/w/.lassi/work');
    expect(dirs.cache).toBe('/w/.lassi/cache');
    expect(dirs.attachments('PROJ-1')).toBe('/w/.lassi/PROJ-1');
  });

  it('writes and reads back frontmatter + body with flow maps', async () => {
    const fs = memFs();
    const file = {
      frontmatter: {
        key: 'PROJ-1',
        summary: 'S',
        labels: ['a'],
        readonly: { status: 'Open', updated: '2026-09-03T14:02:10+0300' },
        counts: { comments: 1, attachments: 0, links: 0 },
        lassi: { fetchedAt: '2026-09-04T10:00:00+0300', product: 'jira', schema: 1 },
      },
      body: 'Body\n',
    };
    await writeWorkingFile('/w/.lassi/work/PROJ-1.md', file, fs);
    const text = await fs.readFile('/w/.lassi/work/PROJ-1.md');
    expect(text).toContain('counts: { comments: 1, attachments: 0, links: 0 }');
    const back = await readWorkingFile('/w/.lassi/work/PROJ-1.md', fs);
    expect(back).toEqual(file);
    const split = splitEditable(back.frontmatter);
    expect(Object.keys(split.editable)).toEqual(['key', 'summary', 'labels']);
    expect(split.readonly).toEqual({ status: 'Open', updated: '2026-09-03T14:02:10+0300' });
    expect(split.lassi?.product).toBe('jira');
  });

  it('rejects files without frontmatter', async () => {
    const fs = memFs({ '/x.md': 'plain' });
    await expect(readWorkingFile('/x.md', fs)).rejects.toMatchObject({ code: 'usage' });
    await expect(readWorkingFile('/missing.md', fs)).rejects.toMatchObject({ code: 'usage' });
  });

  it('diffs editable fields and detects readonly drift', () => {
    const cached = { summary: 'a', labels: ['x', 'y'], priority: 'High', team: null };
    const current = { summary: 'b', labels: ['x', 'y'], team: 'Platform' };
    expect(diffEditable(current, cached)).toEqual({
      changed: [
        { key: 'summary', from: 'a', to: 'b' },
        { key: 'team', from: null, to: 'Platform' },
      ],
      deleted: ['priority'],
    });
    expect(readonlyDrift({ status: 'Done', id: 1 }, { status: 'Open', id: 1 })).toEqual(['status']);
    expect(readonlyDrift(undefined, { status: 'Open' })).toEqual([]);
  });
});

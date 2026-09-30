import { describe, expect, it } from 'vitest';
import {
  componentCreateRequest,
  componentRef,
  componentUpdate,
  planComponentAdd,
  planComponentRemove,
} from './components.js';
import { findByName, nameList } from './named.js';
import type { JiraComponent } from './types.js';

const PROJECT: JiraComponent[] = [
  { id: '10', name: 'Backend' },
  { id: '11', name: 'Frontend' },
  { id: '12', name: 'Legacy', archived: true },
];

function plan(names: string[], opts: { create?: boolean; onIssue?: JiraComponent[] } = {}) {
  return planComponentAdd(names, {
    project: 'PROJ',
    projectComponents: PROJECT,
    issueComponents: opts.onIssue ?? [],
    create: opts.create ?? false,
  });
}

describe('findByName', () => {
  it('prefers the exact spelling, then the one case-insensitive match', () => {
    const items = [{ name: 'api' }, { name: 'API' }, { name: 'Web' }];
    expect(findByName(items, 'API')).toBe(items[1]);
    expect(findByName(items, ' web ')).toBe(items[2]);
    expect(findByName(items, 'mobile')).toBeUndefined();
    expect(() => findByName(items, 'Api')).toThrow(
      expect.objectContaining({ code: 'validation', message: '"Api" matches "api", "API"' })
    );
  });

  it('cuts a long name list after twenty', () => {
    const many = Array.from({ length: 23 }, (_, i) => ({ name: `v${i}` }));
    expect(nameList(many)).toMatch(/^v0, v1, .*, v19, … \(3 more\)$/);
    expect(nameList([])).toBe('none');
  });
});

describe('planComponentAdd', () => {
  it('adds project components by their Jira spelling, once, and keeps the ones already there', () => {
    const result = plan(['backend', 'Frontend', 'BACKEND'], {
      onIssue: [{ id: '11', name: 'Frontend' }],
    });
    expect(result.add.map((c) => c.id)).toEqual(['10']);
    expect(result.unchanged).toEqual(['Frontend']);
    expect(result.create).toEqual([]);
  });

  it('refuses a name the project lacks unless creating, and lists the components', () => {
    expect(() => plan(['Backend', 'Mobile', 'Data'])).toThrow(
      expect.objectContaining({
        code: 'not_found',
        message: 'no components "Mobile", "Data" in PROJ; components: Backend, Frontend',
        hint: 'pass --create to create them, or run `lassi jira component list PROJ`',
      })
    );
    expect(plan(['Backend', 'Mobile', 'mobile'], { create: true })).toEqual({
      add: [PROJECT[0]],
      create: ['Mobile'],
      unchanged: [],
    });
  });

  it('refuses an archived component, and does not create a second one beside it', () => {
    for (const create of [false, true]) {
      expect(() => plan(['legacy'], { create })).toThrow(
        expect.objectContaining({
          code: 'validation',
          message: 'component "Legacy" in PROJ is archived',
        })
      );
    }
  });
});

describe('planComponentRemove', () => {
  const onIssue = [
    { id: '10', name: 'Backend' },
    { id: '11', name: 'Frontend' },
  ];

  it('returns the issue components named', () => {
    expect(
      planComponentRemove(['frontend', 'Frontend'], {
        issueKey: 'PROJ-1',
        issueComponents: onIssue,
      })
    ).toEqual([onIssue[1]]);
  });

  it('refuses a name the issue does not have, listing the ones it has', () => {
    expect(() =>
      planComponentRemove(['Backend', 'Mobile'], { issueKey: 'PROJ-1', issueComponents: onIssue })
    ).toThrow(
      expect.objectContaining({
        code: 'not_found',
        message: 'PROJ-1 has no component "Mobile"; its components: Backend, Frontend',
      })
    );
    expect(() =>
      planComponentRemove(['Backend'], { issueKey: 'PROJ-1', issueComponents: [] })
    ).toThrow(
      expect.objectContaining({ message: expect.stringContaining('its components: none') })
    );
  });
});

describe('component request bodies', () => {
  it('adds and removes by id, or by name for a component not created yet', () => {
    const refs = [componentRef({ id: '10', name: 'Backend' }), componentRef({ name: 'Mobile' })];
    expect(componentUpdate('add', refs)).toEqual({
      update: { components: [{ add: { id: '10' } }, { add: { name: 'Mobile' } }] },
    });
    expect(componentUpdate('remove', [{ id: '10' }])).toEqual({
      update: { components: [{ remove: { id: '10' } }] },
    });
  });

  it('sends a description only when there is one', () => {
    expect(componentCreateRequest({ project: 'PROJ', name: 'Mobile' })).toEqual({
      name: 'Mobile',
      project: 'PROJ',
    });
    expect(
      componentCreateRequest({ project: 'PROJ', name: 'Mobile', description: 'Apps' })
    ).toEqual({ name: 'Mobile', project: 'PROJ', description: 'Apps' });
  });
});

import type { Route } from '@wonna/lassi-core/testing';
import { describe, expect, it } from 'vitest';
import { BOTH_PRODUCTS_ENV, lastJsonLine, makeTestProgram } from '../../test/program.js';

interface Component {
  id: string;
  name: string;
  archived?: boolean;
  lead?: { name: string; displayName: string };
  description?: string;
}
type Ref = { id?: string; name?: string };

/**
 * A Jira project PROJ with components, and issue PROJ-1 carrying some of them. The issue update
 * applies `add` and `remove` the way Jira does, so a test can check what the issue ends up with.
 */
function componentJira(onIssue: string[] = ['Frontend']) {
  const project: Component[] = [
    {
      id: '10',
      name: 'Backend',
      lead: { name: 'jsmith', displayName: 'John Smith' },
      description: 'API and jobs',
    },
    { id: '11', name: 'Frontend' },
    { id: '12', name: 'Legacy', archived: true },
  ];
  const issue = new Set(onIssue.map((n) => project.find((c) => c.name === n)?.id ?? ''));
  let next = 20;
  const find = (ref: Ref) => project.find((c) => c.id === ref.id || c.name === ref.name);
  const routes: Route[] = [
    {
      method: 'GET',
      path: '/rest/api/2/issue/PROJ-1',
      handler: () => ({
        json: {
          id: '1',
          key: 'PROJ-1',
          fields: {
            project: { id: '100', key: 'PROJ' },
            components: project
              .filter((c) => issue.has(c.id))
              .map((c) => ({ id: c.id, name: c.name })),
          },
        },
      }),
    },
    {
      method: 'GET',
      path: '/rest/api/2/project/PROJ/components',
      handler: () => ({ json: project.map((c) => ({ ...c, project: 'PROJ' })) }),
    },
    {
      method: 'GET',
      path: '/rest/api/2/project/NOPE/components',
      status: 404,
      json: { errorMessages: ["No project could be found with key 'NOPE'."] },
    },
    {
      method: 'POST',
      path: '/rest/api/2/component',
      handler: (call) => {
        const body = JSON.parse(call.bodyText ?? '{}') as { name: string };
        const made = { id: String(next++), name: body.name };
        project.push(made);
        return { status: 201, json: { ...made, project: 'PROJ' } };
      },
    },
    {
      method: 'PUT',
      path: '/rest/api/2/issue/PROJ-1',
      handler: (call) => {
        const body = JSON.parse(call.bodyText ?? '{}') as {
          update: { components: Array<{ add?: Ref; remove?: Ref }> };
        };
        for (const op of body.update.components) {
          const target = find(op.add ?? op.remove ?? {});
          if (!target)
            return { status: 400, json: { errors: { components: 'no such component' } } };
          if (op.add) issue.add(target.id);
          else issue.delete(target.id);
        }
        return { status: 204 };
      },
    },
  ];
  return {
    routes,
    onIssue: () => project.filter((c) => issue.has(c.id)).map((c) => c.name),
    inProject: () => project.map((c) => c.name),
  };
}

function program(routes: Route[], env: Record<string, string> = {}) {
  return makeTestProgram({ env: { ...BOTH_PRODUCTS_ENV, ...env }, routes });
}

const writes = (t: ReturnType<typeof program>) => t.fetch.calls.filter((c) => c.method !== 'GET');

describe('lassi jira component list', () => {
  it('lists the project components, archived ones marked', async () => {
    const jira = componentJira();
    const t = program(jira.routes);
    expect(await t.run(['jira', 'component', 'list', 'proj'])).toBe(0);
    expect(t.stdout()).toBe(
      [
        '# PROJ components',
        '',
        '| Name | Id | Lead | Description | Archived |',
        '| - | - | - | - | - |',
        '| Backend | 10 | jsmith | API and jobs | - |',
        '| Frontend | 11 | - | - | - |',
        '| Legacy | 12 | - | - | yes |',
        '',
      ].join('\n')
    );
  });

  it('refuses a key that is not a project key, and hints at a project that does not exist', async () => {
    const jira = componentJira();
    for (const bad of ['.', 'PROJ-1', 'a/b']) {
      const t = program(jira.routes);
      expect(await t.run(['jira', 'component', 'list', bad])).toBe(2);
      expect(t.fetch.calls).toHaveLength(0);
    }
    const missing = program(jira.routes);
    expect(await missing.run(['jira', 'component', 'list', 'NOPE'])).toBe(4);
    expect(lastJsonLine(missing.stderr())).toMatchObject({
      code: 'not_found',
      hint: 'check the project key NOPE (the part of an issue key before the dash)',
    });
  });
});

describe('lassi jira component create', () => {
  it('creates a component, and previews the request first under --dry-run', async () => {
    const jira = componentJira();
    const dry = program(jira.routes);
    expect(
      await dry.run([
        'jira',
        'component',
        'create',
        'PROJ',
        'Mobile',
        '--description',
        'Apps',
        '--dry-run',
      ])
    ).toBe(0);
    expect(dry.stdout()).toBe(
      'DRY RUN — nothing sent\nPOST /rest/api/2/component\n--- component (json) ---\n{\n  "name": "Mobile",\n  "project": "PROJ",\n  "description": "Apps"\n}\n'
    );
    expect(writes(dry)).toHaveLength(0);

    const t = program(jira.routes);
    expect(await t.run(['jira', 'component', 'create', 'PROJ', 'Mobile', '--json'])).toBe(0);
    expect(JSON.parse(t.stdout())).toMatchObject({ id: '20', name: 'Mobile' });
    expect(jira.inProject()).toContain('Mobile');
  });

  it('refuses a name the project already has, in any case', async () => {
    const t = program(componentJira().routes);
    expect(await t.run(['jira', 'component', 'create', 'PROJ', 'backend'])).toBe(5);
    expect(lastJsonLine(t.stderr())).toMatchObject({
      code: 'validation',
      message: 'component "Backend" already exists in PROJ (id 10)',
      hint: 'add it to an issue with `lassi jira issue component add <KEY> "Backend"`',
    });
    expect(writes(t)).toHaveLength(0);
  });

  it('explains a 403 as the project permission, not the token', async () => {
    const jira = componentJira();
    const t = program([
      {
        method: 'POST',
        path: '/rest/api/2/component',
        status: 403,
        json: { errorMessages: ['You cannot edit the configuration of this project.'] },
      },
      ...jira.routes,
    ]);
    expect(await t.run(['jira', 'component', 'create', 'PROJ', 'Mobile'])).not.toBe(0);
    expect(lastJsonLine(t.stderr())).toMatchObject({
      code: 'auth',
      hint: 'creating a component needs the Administer Projects permission in PROJ; ask a project admin, or use an existing component (`lassi jira component list PROJ`)',
    });
  });
});

describe('lassi jira issue component add', () => {
  it('adds components by id and keeps the ones the issue has', async () => {
    const jira = componentJira();
    const t = program(jira.routes);
    expect(await t.run(['jira', 'issue', 'component', 'add', 'PROJ-1', 'backend'])).toBe(0);
    expect(t.stdout()).toBe('added Backend to PROJ-1\n');
    expect(writes(t)).toHaveLength(1);
    expect(JSON.parse(writes(t)[0]?.bodyText ?? '')).toEqual({
      update: { components: [{ add: { id: '10' } }] },
    });
    expect(jira.onIssue()).toEqual(['Backend', 'Frontend']);
  });

  it('sends nothing when the issue already has every component', async () => {
    const t = program(componentJira().routes);
    expect(await t.run(['jira', 'issue', 'component', 'add', 'PROJ-1', 'Frontend', '--json'])).toBe(
      0
    );
    expect(JSON.parse(t.stdout())).toEqual({
      key: 'PROJ-1',
      added: [],
      created: [],
      unchanged: ['Frontend'],
    });
    expect(writes(t)).toHaveLength(0);
  });

  it('refuses a component the project lacks without --create, before sending anything', async () => {
    const jira = componentJira();
    const t = program(jira.routes);
    expect(await t.run(['jira', 'issue', 'component', 'add', 'PROJ-1', 'Backend', 'Mobile'])).toBe(
      4
    );
    expect(lastJsonLine(t.stderr())).toMatchObject({
      code: 'not_found',
      message: 'no component "Mobile" in PROJ; components: Backend, Frontend',
      hint: 'pass --create to create it, or run `lassi jira component list PROJ`',
    });
    expect(writes(t)).toHaveLength(0);
    expect(jira.onIssue()).toEqual(['Frontend']);
  });

  it('refuses an archived component', async () => {
    const t = program(componentJira().routes);
    expect(await t.run(['jira', 'issue', 'component', 'add', 'PROJ-1', 'Legacy', '--create'])).toBe(
      5
    );
    expect(writes(t)).toHaveLength(0);
  });

  it('creates a missing component with --create, then adds it by its new id', async () => {
    const jira = componentJira();
    const t = program(jira.routes);
    expect(
      await t.run(['jira', 'issue', 'component', 'add', 'PROJ-1', 'Backend', 'Mobile', '--create'])
    ).toBe(0);
    expect(t.stdout()).toBe('added Backend, Mobile to PROJ-1 (created Mobile in PROJ)\n');
    expect(writes(t).map((c) => `${c.method} ${c.url.pathname}`)).toEqual([
      'POST /rest/api/2/component',
      'PUT /rest/api/2/issue/PROJ-1',
    ]);
    expect(JSON.parse(writes(t)[0]?.bodyText ?? '')).toEqual({ name: 'Mobile', project: 'PROJ' });
    expect(JSON.parse(writes(t)[1]?.bodyText ?? '')).toEqual({
      update: { components: [{ add: { id: '10' } }, { add: { id: '20' } }] },
    });
    expect(jira.onIssue()).toEqual(['Backend', 'Frontend', 'Mobile']);
  });

  it('previews the create and the update under --dry-run and sends neither', async () => {
    const jira = componentJira();
    const dry = program(jira.routes);
    expect(
      await dry.run([
        'jira',
        'issue',
        'component',
        'add',
        'PROJ-1',
        'Mobile',
        '--create',
        '--dry-run',
      ])
    ).toBe(0);
    expect(dry.stdout()).toBe(
      [
        'DRY RUN — nothing sent',
        'POST /rest/api/2/component',
        '--- component (json) ---',
        '{\n  "name": "Mobile",\n  "project": "PROJ"\n}',
        'DRY RUN — nothing sent',
        'PUT /rest/api/2/issue/PROJ-1',
        'adds Mobile to PROJ-1; the components created first are sent by id',
        '--- update (json) ---',
        '{\n  "update": {\n    "components": [\n      {\n        "add": {\n          "name": "Mobile"\n        }\n      }\n    ]\n  }\n}',
        '',
      ].join('\n')
    );
    const json = program(jira.routes);
    expect(
      await json.run([
        'jira',
        'issue',
        'component',
        'add',
        'PROJ-1',
        'Mobile',
        '--create',
        '--dry-run',
        '--json',
      ])
    ).toBe(0);
    expect(JSON.parse(json.stdout())).toMatchObject({
      dryRun: true,
      method: 'PUT',
      path: '/rest/api/2/issue/PROJ-1',
      creates: [{ method: 'POST', path: '/rest/api/2/component' }],
    });
    expect([...writes(dry), ...writes(json)]).toHaveLength(0);
    expect(jira.inProject()).not.toContain('Mobile');
  });

  it('is blocked under read-only before any request', async () => {
    const t = program(componentJira().routes, { LASSI_READ_ONLY: '1' });
    expect(await t.run(['jira', 'issue', 'component', 'add', 'PROJ-1', 'Backend'])).toBe(7);
    expect(t.fetch.calls).toHaveLength(0);
  });

  it('reports the components it created as data when the issue update then fails', async () => {
    const failingUpdate: Route = {
      method: 'PUT',
      path: '/rest/api/2/issue/PROJ-1',
      status: 400,
      json: {
        errors: {
          components:
            "Field 'components' cannot be set. It is not on the appropriate screen, or unknown.",
        },
      },
    };
    const jira = componentJira();
    const t = program([failingUpdate, ...jira.routes]);
    const args = ['jira', 'issue', 'component', 'add', 'PROJ-1', 'Mobile', '--create'];
    expect(await t.run(args)).toBe(5);
    expect(t.stdout()).toBe('created Mobile in PROJ; added nothing to PROJ-1\n');
    expect(lastJsonLine(t.stderr())).toMatchObject({ code: 'validation' });

    const json = program([failingUpdate, ...componentJira().routes]);
    expect(await json.run([...args, '--json'])).toBe(5);
    expect(JSON.parse(json.stdout())).toEqual({
      key: 'PROJ-1',
      added: [],
      created: [{ id: '20', name: 'Mobile' }],
      unchanged: [],
    });
    expect(jira.inProject()).toContain('Mobile');
    expect(jira.onIssue()).toEqual(['Frontend']);
  });
});

describe('lassi jira issue component remove', () => {
  it('removes a component from the issue and leaves it in the project', async () => {
    const jira = componentJira(['Backend', 'Frontend']);
    const t = program(jira.routes);
    expect(await t.run(['jira', 'issue', 'component', 'remove', 'PROJ-1', 'frontend'])).toBe(0);
    expect(t.stdout()).toBe('removed Frontend from PROJ-1\n');
    expect(JSON.parse(writes(t)[0]?.bodyText ?? '')).toEqual({
      update: { components: [{ remove: { id: '11' } }] },
    });
    expect(jira.onIssue()).toEqual(['Backend']);
    expect(jira.inProject()).toContain('Frontend');
  });

  it('refuses a component the issue does not have, listing the ones it has', async () => {
    const jira = componentJira(['Frontend']);
    const t = program(jira.routes);
    expect(await t.run(['jira', 'issue', 'component', 'remove', 'PROJ-1', 'Backend'])).toBe(4);
    expect(lastJsonLine(t.stderr())).toMatchObject({
      code: 'not_found',
      message: 'PROJ-1 has no component "Backend"; its components: Frontend',
    });
    expect(writes(t)).toHaveLength(0);
  });

  it('previews the removal under --dry-run', async () => {
    const jira = componentJira(['Frontend']);
    const dry = program(jira.routes);
    expect(
      await dry.run(['jira', 'issue', 'component', 'remove', 'PROJ-1', 'Frontend', '--dry-run'])
    ).toBe(0);
    expect(dry.stdout()).toContain('PUT /rest/api/2/issue/PROJ-1\nremoves Frontend from PROJ-1\n');
    expect(writes(dry)).toHaveLength(0);
    expect(jira.onIssue()).toEqual(['Frontend']);
  });
});

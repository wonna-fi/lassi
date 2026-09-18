import { describe, expect, it } from 'vitest';
import { assertPublishContext, assertPublicSource } from './policy.mjs';

const commit = 'a'.repeat(40);
const context = () => ({
  env: {
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_REPOSITORY: 'wonna-fi/lassi',
    GITHUB_EVENT_NAME: 'push',
    GITHUB_REF: 'refs/tags/v0.1.0-alpha.1',
    GITHUB_SHA: commit,
  },
  version: '0.1.0-alpha.1',
  commit,
  clean: true,
  taggedCommit: commit,
  buildInfo: { commit, dirty: false },
});

describe('publication authorization', () => {
  it('accepts the exact tagged source built from a clean checkout', () => {
    expect(() => assertPublishContext(context())).not.toThrow();
  });

  it.each([
    ['GITHUB_REPOSITORY', 'example/lassi'],
    ['GITHUB_SERVER_URL', 'https://github.example.internal'],
    ['GITHUB_EVENT_NAME', 'pull_request'],
    ['GITHUB_EVENT_NAME', 'workflow_dispatch'],
    ['GITHUB_REF', 'refs/heads/main'],
    ['GITHUB_REF', 'refs/tags/v0.1.0-alpha.2'],
    ['GITHUB_SHA', 'b'.repeat(40)],
  ])('rejects %s=%s', (key, value) => {
    const input = context();
    input.env[key] = value;
    expect(() => assertPublishContext(input)).toThrow();
  });

  it('rejects a retag, a rebuilt package from another commit, or local modifications', () => {
    expect(() => assertPublishContext({ ...context(), taggedCommit: 'b'.repeat(40) })).toThrow(
      /tag differs/
    );
    expect(() =>
      assertPublishContext({ ...context(), buildInfo: { commit: 'b'.repeat(40), dirty: false } })
    ).toThrow(/different commit/);
    expect(() =>
      assertPublishContext({ ...context(), buildInfo: { commit, dirty: true } })
    ).toThrow(/clean checkout/);
    expect(() => assertPublishContext({ ...context(), clean: false })).toThrow(/clean checkout/);
  });

  it('verifies repository visibility and tag resolution without authentication', async () => {
    const seen = [];
    const fakeFetch = async (url, options) => {
      seen.push(url);
      expect(
        Object.keys(options.headers).some((key) => key.toLowerCase() === 'authorization')
      ).toBe(false);
      expect(options.redirect).toBe('error');
      return Response.json(
        seen.length === 1 ? { full_name: 'wonna-fi/lassi', private: false } : { sha: commit }
      );
    };
    await assertPublicSource(context(), fakeFetch);
    expect(seen).toEqual([
      'https://api.github.com/repos/wonna-fi/lassi',
      'https://api.github.com/repos/wonna-fi/lassi/commits/v0.1.0-alpha.1',
    ]);
  });

  it.each([403, 404, 500])(
    'fails closed when public source is inaccessible (%i)',
    async (status) => {
      await expect(
        assertPublicSource(context(), async () => new Response('', { status }))
      ).rejects.toThrow(/Public source check failed/);
    }
  );

  it('rejects a private repository before requesting the tag', async () => {
    let calls = 0;
    await expect(
      assertPublicSource(context(), async () => {
        calls += 1;
        return Response.json({ full_name: 'wonna-fi/lassi', private: true });
      })
    ).rejects.toThrow(/must be public/);
    expect(calls).toBe(1);
  });

  it('rejects a public tag that moved to another commit', async () => {
    await expect(
      assertPublicSource(context(), async (url) =>
        Response.json(
          url.endsWith('/lassi')
            ? { full_name: 'wonna-fi/lassi', private: false }
            : { sha: 'b'.repeat(40) }
        )
      )
    ).rejects.toThrow(/tag differs/);
  });
});

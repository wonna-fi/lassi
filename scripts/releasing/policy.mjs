import assert from 'node:assert/strict';

export const publicRepository = 'wonna-fi/lassi';

export function assertPublishContext({ env, version, commit, buildInfo, clean, taggedCommit }) {
  assert.equal(
    env.GITHUB_SERVER_URL,
    'https://github.com',
    'Publishing requires GitHub.com Actions'
  );
  assert.equal(env.GITHUB_REPOSITORY, publicRepository, `Publishing requires ${publicRepository}`);
  assert.equal(env.GITHUB_EVENT_NAME, 'push', 'Only an explicit tag push can publish');
  assert.equal(
    env.GITHUB_REF,
    `refs/tags/v${version}`,
    'The release tag must match the package version'
  );
  assert.equal(env.GITHUB_SHA, commit, 'The checkout differs from the workflow commit');
  assert.equal(taggedCommit, commit, 'The release tag differs from the checkout');
  assert.equal(buildInfo.commit, commit, 'The package was built from a different commit');
  assert.equal(buildInfo.dirty, false, 'The package must be built from a clean checkout');
  assert.equal(clean, true, 'Publishing requires a clean checkout');
}

export async function assertPublicSource({ version, commit }, fetchImpl) {
  const get = async (suffix) => {
    // Anonymous reads ensure the source is accessible to package users without credentials.
    const response = await fetchImpl(`https://api.github.com/repos/${publicRepository}${suffix}`, {
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
    assert.equal(response.status, 200, `Public source check failed (${response.status})`);
    return response.json();
  };
  const repository = await get('');
  assert.equal(repository.full_name, publicRepository);
  assert.equal(repository.private, false, 'The source repository must be public');
  const tag = await get(`/commits/${encodeURIComponent(`v${version}`)}`);
  assert.equal(tag.sha, commit, 'The public release tag differs from the package source');
}

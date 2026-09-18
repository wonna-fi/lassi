import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { appendFileSync } from 'node:fs';

// Only loaded by the package verifier, keeping real credentials and the real home out of tests.
os.homedir = () => process.env.LASSI_TEST_HOME;
syncBuiltinESMExports();
const comments = [
  {
    id: '1',
    body: 'Retry a failed deployment after checking the logs.',
    created: '2026-01-01T12:00:00Z',
  },
];
const issue = {
  id: '1',
  key: 'PROJ-1',
  fields: {
    summary: 'Deployment retry policy',
    description: 'A failed deployment can be retried after diagnosis.',
    updated: '2026-01-01T12:00:00Z',
    comment: { comments, total: 1, startAt: 0, maxResults: 50 },
    attachment: [
      {
        id: '10',
        filename: 'notes.txt',
        size: 4,
        mimeType: 'text/plain',
        content: 'https://jira.example.internal/secure/attachment/10',
      },
    ],
    issuelinks: [],
  },
};

globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  const method = init?.method ?? 'GET';
  appendFileSync(
    process.env.LASSI_TEST_REQUESTS,
    JSON.stringify({ path: url.pathname, method }) + '\n'
  );
  if (
    url.origin === 'https://jira.example.internal' &&
    url.pathname === '/rest/api/2/search' &&
    method === 'POST'
  ) {
    return Response.json({ issues: [issue], startAt: 0, maxResults: 100, total: 1 });
  }
  if (url.origin === 'https://jira.example.internal' && method === 'GET') {
    if (url.pathname === '/rest/api/2/issue/PROJ-1') return Response.json(issue);
    if (url.pathname === '/rest/api/2/issue/PROJ-1/comment')
      return Response.json({ comments, total: 1, startAt: 0, maxResults: 50 });
    if (url.pathname === '/rest/api/2/search')
      return Response.json({ issues: [issue], startAt: 0, maxResults: 100, total: 1 });
    if (url.pathname === '/rest/api/2/issueLinkType') return Response.json({ issueLinkTypes: [] });
    if (url.pathname === '/secure/attachment/10')
      return new Response('demo', { headers: { 'content-type': 'text/plain' } });
  }
  if (url.href === 'https://embeddings.example.internal/v1/embeddings' && method === 'POST') {
    const body = JSON.parse(init.body);
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    return Response.json({ data: inputs.map((_, index) => ({ index, embedding: [1, 0] })) });
  }
  throw new Error(`Unexpected fixture request: ${method} ${url.pathname}`);
};

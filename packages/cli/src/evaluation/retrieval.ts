import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { JiraIssue } from '@wonna/lassi-jira';
import type { Route } from '@wonna/lassi-core/testing';
import { BOTH_PRODUCTS_ENV, makeTestProgram } from '../test/program.js';
import { retrievalMetrics, type RetrievalQuestion, type RetrievalResult } from './metrics.js';

export interface RetrievalCorpus {
  version: string;
  issues: JiraIssue[];
  attachments: Record<string, string>;
  queries: RetrievalQuestion[];
}

/** Deliberately weak lexical vectors: deterministic pipeline checks, never a relevance baseline. */
export function fixtureEmbedding(text: string): Float32Array {
  const v = new Float32Array(256);
  for (const token of text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []) {
    const digest = createHash('sha256').update(token).digest();
    const i = digest[0] as number;
    v[i] = (v[i] ?? 0) + 1;
  }
  return v;
}

/** Real CLI commands with fabricated Jira responses; only the injected embed callback may be live. */
export async function evaluateRetrieval(
  corpus: RetrievalCorpus,
  opts: {
    embed: (texts: string[]) => Promise<Float32Array[]>;
    attachmentDir: string;
    model: string;
    minScore?: number;
    chunkChars?: number;
    chunkOverlap?: number;
    batchSize?: number;
  }
) {
  let embeddingRequests = 0;
  let embeddedTexts = 0;
  let embeddedCharacters = 0;
  const routes: Route[] = [
    {
      method: 'POST',
      path: '/rest/api/2/search',
      handler: (c) => {
        const { startAt = 0, maxResults = 100 } = JSON.parse(c.bodyText ?? '{}');
        return {
          json: {
            startAt,
            maxResults,
            total: corpus.issues.length,
            issues: corpus.issues.slice(startAt, startAt + maxResults).map((issue) => ({
              ...issue,
              fields: {
                ...issue.fields,
                comment: {
                  ...issue.fields.comment,
                  comments: issue.fields.comment?.comments.slice(0, 2),
                  maxResults: 2,
                },
              },
            })),
          },
        };
      },
    },
    ...corpus.issues.flatMap(
      (issue) =>
        [
          {
            path: `/rest/api/2/issue/${issue.key}`,
            json: {
              ...issue,
              fields: {
                ...issue.fields,
                comment: {
                  ...issue.fields.comment,
                  comments: issue.fields.comment?.comments.slice(0, 2),
                  maxResults: 2,
                },
              },
            },
          },
          {
            path: `/rest/api/2/issue/${issue.key}/comment`,
            handler: (c) => {
              const startAt = Number(c.url.searchParams.get('startAt'));
              const maxResults = Math.min(2, Number(c.url.searchParams.get('maxResults')));
              const all = [...(issue.fields.comment?.comments ?? [])];
              if (c.url.searchParams.get('orderBy') === '-created') all.reverse();
              return {
                json: {
                  startAt,
                  maxResults,
                  total: all.length,
                  comments: all.slice(startAt, startAt + maxResults),
                },
              };
            },
          },
        ] satisfies Route[]
    ),
    ...Object.entries(corpus.attachments).map(([id, text]) => ({
      path: `/download/${id}`,
      bytes: new TextEncoder().encode(text),
    })),
    {
      method: 'POST',
      path: '/v1/embeddings',
      handler: async (c) => {
        const texts = JSON.parse(c.bodyText ?? '{}').input as string[];
        embeddingRequests++;
        embeddedTexts += texts.length;
        embeddedCharacters += texts.reduce((n, t) => n + t.length, 0);
        const vectors = await opts.embed(texts);
        return { json: { data: vectors.map((v, index) => ({ index, embedding: Array.from(v) })) } };
      },
    },
  ];
  const p = makeTestProgram({
    routes,
    env: {
      ...BOTH_PRODUCTS_ENV,
      LASSI_EMBEDDINGS_URL: 'https://embeddings.example.internal/v1',
      LASSI_EMBEDDINGS_API_KEY: 'fixture',
    },
    files: {
      '/home/u/.lassi.json': JSON.stringify({
        // The injected live client owns retries; this fabricated transport must not multiply them.
        http: { retries: 1 },
        embeddings: {
          model: opts.model,
          minScore: opts.minScore ?? 0.33,
          chunkChars: opts.chunkChars ?? 1500,
          chunkOverlap: opts.chunkOverlap ?? 200,
          batchSize: opts.batchSize ?? 64,
        },
      }),
    },
  });
  const commands: Array<{ argv: string[]; stdoutBytes: number; requests: number }> = [];
  const run = async (args: string[]) => {
    const before = p.stdout().length;
    const requests = p.fetch.calls.length;
    const errors = p.stderr().length;
    const code = await p.run([...args, '--json']);
    if (code !== 0)
      throw new Error(
        `evaluation command failed (${code}): ${args.join(' ')}\n${p.stderr().slice(errors)}`
      );
    const output = p.stdout().slice(before);
    commands.push({
      argv: args,
      stdoutBytes: Buffer.byteLength(output),
      requests: p.fetch.calls.length - requests,
    });
    return JSON.parse(output);
  };
  const issue = await run(['jira', 'issue', 'get', 'PROJ-101', '--all']);
  const attachments = await run(['jira', 'attach', 'get', 'PROJ-112', '--out', opts.attachmentDir]);
  const attachmentText = await readFile(resolve(p.deps.cwd, attachments.files[0].path), 'utf8');
  await run(['jira', 'issue', 'export', 'project = PROJ', '--comments']);
  const index = await run(['search', 'index']);
  const indexRequests = embeddingRequests;
  const results: RetrievalResult[] = [];
  for (const question of corpus.queries) {
    const response = await run(['search', 'query', question.query, '--limit', '10']);
    results.push({
      ...question,
      hits: response.hits.map((h: { ref: string; score: number }) => ({
        ref: h.ref,
        score: h.score,
      })),
    });
  }
  if (p.fetch.unmatched.length) throw new Error('evaluation attempted an unexpected HTTP request');
  const exported = await p.fs.readFile('/home/u/.lassi/export/jira/PROJ-101.md');
  return {
    corpus: corpus.version,
    model: opts.model,
    minScore: opts.minScore ?? 0.33,
    configuration: {
      chunkChars: opts.chunkChars ?? 1500,
      chunkOverlap: opts.chunkOverlap ?? 200,
      batchSize: opts.batchSize ?? 64,
    },
    metrics: retrievalMetrics(results),
    pipeline: {
      discussion: issue.commentCoverage,
      lateCommentExported: exported.includes('singleFlightRefresh'),
      attachments: {
        saved: attachments.saved,
        complete: attachments.complete,
        readBytes: Buffer.byteLength(attachmentText),
      },
      attachmentOnlyTextIndexed: (
        await p.fs.readFile('/home/u/.lassi/index/default/chunks.jsonl')
      ).includes('E_STREAM_742'),
      documents: index.documents,
      dimensions: index.dimensions,
      chunks: index.chunks,
    },
    cost: {
      embeddingRequests,
      indexRequests,
      queryRequests: embeddingRequests - indexRequests,
      embeddedTexts,
      embeddedCharacters,
      stdoutBytes: commands.reduce((n, c) => n + c.stdoutBytes, 0),
    },
    commands,
    results,
  };
}

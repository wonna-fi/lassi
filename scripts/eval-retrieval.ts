/** Default: fabricated data and deterministic vectors. --live uses only configured embeddings. */
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import {
  evaluateRetrieval,
  fixtureEmbedding,
  type RetrievalCorpus,
} from '../packages/cli/dist/evaluation/retrieval.js';
import { buildContext } from '../packages/cli/dist/context.js';
import { realDeps } from '../packages/cli/dist/deps.js';
import { assertWriteAllowed } from '../packages/cli/dist/guard-write.js';
import { embeddingsClient } from '../packages/cli/dist/commands/search/shared.js';

const { values } = parseArgs({
  options: {
    live: { type: 'boolean', default: false },
    config: { type: 'string' },
    report: { type: 'string' },
  },
});
const source = await readFile(
  new URL('../fixtures/search/retrieval-v1.json', import.meta.url),
  'utf8'
);
const corpus = JSON.parse(source) as RetrievalCorpus;
const attachmentDir = await mkdtemp(join(tmpdir(), 'lassi-retrieval-eval-'));
let endpointRequests = 0;
try {
  const deps = realDeps();
  const fetch = deps.fetch;
  deps.fetch = async (...args) => {
    endpointRequests++;
    return fetch(...args);
  };
  const ctx = values.live ? await buildContext(deps, { config: values.config }) : undefined;
  if (ctx) assertWriteAllowed(ctx);
  const config = ctx ? await ctx.embeddings() : undefined;
  const client = ctx ? await embeddingsClient(ctx) : undefined;
  const start = performance.now();
  const result = await evaluateRetrieval(corpus, {
    attachmentDir,
    model: client?.model ?? 'fixture-lexical-stub',
    minScore: config?.minScore,
    chunkChars: config?.chunkChars,
    chunkOverlap: config?.chunkOverlap,
    batchSize: config?.batchSize,
    embed: client ? (texts) => client.embed(texts) : async (texts) => texts.map(fixtureEmbedding),
  });
  const report = {
    mode: values.live ? 'configured-endpoint' : 'pipeline-stub',
    corpusSha256: createHash('sha256').update(source).digest('hex'),
    elapsedMs: Math.round(performance.now() - start),
    endpointRequests,
    ...result,
  };
  const text = JSON.stringify(report, null, 2) + '\n';
  if (values.report) await writeFile(values.report, text);
  else process.stdout.write(text);
} finally {
  await rm(attachmentDir, { recursive: true, force: true });
}

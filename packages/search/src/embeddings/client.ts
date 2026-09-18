import { LassiError, type HttpClient, type Logger } from '@wonna/lassi-core';

export interface EmbeddingsClientOptions {
  http: HttpClient;
  model: string;
  /** Azure OpenAI: sent as `?api-version=` on every call. */
  apiVersion?: string;
  /** Requested output size (OpenAI `dimensions`); the response is checked against it. */
  dimensions?: number;
  batchSize?: number;
  logger?: Logger;
}

export interface EmbeddingsClient {
  readonly model: string;
  /** One vector per input, in input order; batches transparently. */
  embed(texts: string[]): Promise<Float32Array[]>;
}

interface EmbeddingsResponse {
  data?: Array<{ index?: number; embedding?: number[] }>;
  model?: string;
}

/**
 * The OpenAI `POST /embeddings` shape (`{ model, input[], dimensions? }` → `data[{index, embedding}]`),
 * which OpenAI, Azure OpenAI, Ollama and most self-hosted servers speak. Inputs are content and are
 * never logged; the request is declared idempotent so 429s retry with Retry-After.
 */
export function createEmbeddingsClient(opts: EmbeddingsClientOptions): EmbeddingsClient {
  const batchSize = Math.max(1, opts.batchSize ?? 64);
  return {
    model: opts.model,
    async embed(texts) {
      const out: Float32Array[] = [];
      // The width the endpoint actually produced, kept apart from the one that was asked for:
      // Ollama ignores the `dimensions` field, and saying "after N-dimensional ones" about a width
      // that was never returned sent the user off to pin a setting they had already pinned.
      let seen: number | undefined;
      for (let start = 0; start < texts.length; start += batchSize) {
        const batch = texts.slice(start, start + batchSize);
        opts.logger?.debug(
          `embeddings: batch of ${batch.length} (${start + batch.length}/${texts.length})`
        );
        const response = await opts.http.post<EmbeddingsResponse>(
          '/embeddings',
          {
            model: opts.model,
            input: batch,
            ...(opts.dimensions === undefined ? {} : { dimensions: opts.dimensions }),
          },
          {
            idempotent: true,
            ...(opts.apiVersion === undefined ? {} : { query: { 'api-version': opts.apiVersion } }),
          }
        );
        const data = [...(response?.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
        if (data.length !== batch.length) {
          throw new LassiError(
            'validation',
            `embeddings endpoint returned ${data.length} vectors for ${batch.length} inputs`,
            {
              hint: 'check embeddings.url and embeddings.model; the endpoint must speak the OpenAI /embeddings shape',
            }
          );
        }
        for (const item of data) {
          const vector = item.embedding;
          if (!Array.isArray(vector) || vector.length === 0) {
            throw new LassiError('validation', 'embeddings endpoint returned an empty vector');
          }
          // A string or a null becomes NaN through Float32Array.from, and a NaN in the stored
          // matrix poisons every later query: it survives normalisation and no comparison rejects
          // it, so the similarity floor stops being a floor.
          if (!vector.every((v) => typeof v === 'number' && Number.isFinite(v))) {
            throw new LassiError(
              'validation',
              'embeddings endpoint returned a vector with a value that is not a finite number',
              {
                hint: 'check embeddings.url and embeddings.model; the endpoint must speak the OpenAI /embeddings shape',
              }
            );
          }
          if (opts.dimensions !== undefined && vector.length !== opts.dimensions) {
            throw new LassiError(
              'validation',
              `embeddings.dimensions is ${opts.dimensions} but the endpoint returned ${vector.length}-dimensional vectors`,
              {
                hint: 'the endpoint ignored the requested dimensions; remove embeddings.dimensions, or choose a model that honours it',
              }
            );
          }
          seen ??= vector.length;
          if (vector.length !== seen) {
            throw new LassiError(
              'validation',
              `embeddings endpoint returned ${vector.length}-dimensional vectors after ${seen}-dimensional ones`,
              { hint: 'pin embeddings.dimensions, or rebuild the index with a single model' }
            );
          }
          out.push(Float32Array.from(vector));
        }
      }
      return out;
    },
  };
}

import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import { copyFile, link, lstat, mkdir, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable, Transform, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { LassiError } from '../errors/lassi-error.js';

export interface SaveStreamOptions {
  /** Hard cap; exceeding it aborts the transfer and leaves no partial file behind. */
  maxBytes?: number;
  signal?: AbortSignal;
  /** Publish without replacing an existing file; identical bytes may be reused. */
  preserveExisting?: boolean;
}

function byteCap(maxBytes: number | undefined): Transform & { bytes: number; digest(): string } {
  let total = 0;
  const hash = createHash('sha256');
  const t = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      total += chunk.length;
      hash.update(chunk);
      t.bytes = total;
      if (maxBytes !== undefined && total > maxBytes) {
        cb(
          new LassiError('validation', `download exceeds the ${maxBytes} byte limit`, {
            context: {},
          })
        );
        return;
      }
      cb(null, chunk);
    },
  }) as Transform & { bytes: number; digest(): string };
  t.bytes = 0;
  t.digest = () => hash.digest('hex');
  return t;
}

/** Some removable and network filesystems support exclusive creation but not hard links. */
export async function publishExclusive(
  from: string,
  to: string,
  io = { link, copyFile }
): Promise<void> {
  try {
    await io.link(from, to);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV'].includes(code ?? '')) throw err;
    await io.copyFile(from, to, constants.COPYFILE_EXCL);
  }
}

/**
 * Streams a web `ReadableStream` to a file path (through a unique temporary file) or to any
 * `Writable`. Counting bytes while piping enforces the cap even when Content-Length lies.
 */
export async function saveStream(
  body: ReadableStream<Uint8Array>,
  dest: string | Writable,
  opts: SaveStreamOptions = {}
): Promise<{ bytes: number; unchanged?: boolean }> {
  const counter = byteCap(opts.maxBytes);
  const source = () =>
    Readable.fromWeb(body as import('node:stream/web').ReadableStream<Uint8Array>);
  const pipelineOpts = opts.signal ? { signal: opts.signal } : {};

  if (typeof dest !== 'string') {
    await pipeline(source(), counter, dest, pipelineOpts);
    return { bytes: counter.bytes };
  }

  const partial = join(dirname(dest), `.lassi-${randomUUID()}.part`);
  try {
    await mkdir(dirname(dest), { recursive: true });
    await pipeline(source(), counter, createWriteStream(partial, { flags: 'wx' }), pipelineOpts);
    if (!opts.preserveExisting) {
      await rename(partial, dest);
    } else {
      try {
        // Linking publishes atomically without overwriting a destination created during download.
        await publishExclusive(partial, dest);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        const stat = await lstat(dest);
        if (stat.isFile() && stat.size === counter.bytes) {
          const hash = createHash('sha256');
          for await (const chunk of createReadStream(dest)) hash.update(chunk as Buffer);
          if (hash.digest('hex') === counter.digest())
            return { bytes: counter.bytes, unchanged: true };
        }
        throw new LassiError(
          'conflict',
          `${dest} already exists with different content; preserved`,
          {
            hint: 'choose another --out directory, or back up and remove only the conflicting file before retrying',
          }
        );
      }
    }
    return { bytes: counter.bytes };
  } finally {
    if (!body.locked) await body.cancel().catch(() => undefined);
    await unlink(partial).catch(() => undefined);
  }
}

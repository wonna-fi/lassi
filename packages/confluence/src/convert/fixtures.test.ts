import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitFrontmatter } from '@wonna/lassi-core';
import { describe, expect, it } from 'vitest';
import { checkFidelity } from './fidelity.js';
import { createStorageConverter } from './index.js';
import { normalizeConfluenceMarkdown, stringifyConfluenceMarkdown } from './md/index.js';
import { markdownToStorage } from './mdast-to-storage.js';
import { normalizeStorage } from './normalize.js';
import { storageToMdast } from './storage-to-mdast.js';
import { EMPTY_DIRECTORY, userDirectory, type UserDirectory } from './users.js';
import type { ConverterWarning } from './warnings.js';
import {
  DEFAULT_WRITER_OPTIONS,
  inferWriterOptions,
  type StorageWriterOptions,
} from './writer-options.js';

const ROOT = fileURLToPath(new URL('../../../../fixtures/confluence', import.meta.url));

export interface ConfluenceFixture {
  name: string;
  storage: string;
  markdown: string;
  direction: 'both' | 'read' | 'write';
  roundtrip: boolean;
  writer: Record<string, string>;
  users: UserDirectory;
  gateDiff?: string;
  normalized?: string;
  readback?: string;
  readWarnings: ConverterWarning[];
  writeWarnings: Array<{ code: string; line?: number }>;
}

/** Fixture files end with one newline that is not part of the byte spec (see the README). */
function spec(text: string): string {
  return text.endsWith('\n') ? text.slice(0, -1) : text;
}

function optional(path: string): string | undefined {
  return existsSync(path) ? spec(readFileSync(path, 'utf8')) : undefined;
}

export function loadFixtures(): ConfluenceFixture[] {
  return readdirSync(ROOT)
    .filter((name) => existsSync(join(ROOT, name, 'storage.xml')))
    .sort()
    .map((name) => {
      const dir = join(ROOT, name);
      const notes = splitFrontmatter(readFileSync(join(dir, 'notes.md'), 'utf8')).data ?? {};
      const users = notes['users'] as Record<string, string> | undefined;
      const warnings = optional(join(dir, 'warnings.json'));
      const parsed = warnings
        ? (JSON.parse(warnings) as {
            read?: ConverterWarning[];
            write?: Array<{ code: string; line?: number }>;
          })
        : {};
      const normalized = optional(join(dir, 'storage.normalized.xml'));
      const readback = existsSync(join(dir, 'markdown.readback.md'))
        ? readFileSync(join(dir, 'markdown.readback.md'), 'utf8')
        : undefined;
      const gateDiff = notes['gate-diff'] as string | undefined;
      return {
        name,
        storage: spec(readFileSync(join(dir, 'storage.xml'), 'utf8')),
        markdown: readFileSync(join(dir, 'markdown.md'), 'utf8'),
        direction: (notes['direction'] as ConfluenceFixture['direction']) ?? 'both',
        roundtrip: notes['roundtrip'] !== false,
        writer: (notes['writer'] as Record<string, string> | undefined) ?? {},
        users: users
          ? userDirectory(
              Object.entries(users).map(([userKey, username]) => ({ userKey, username }))
            )
          : EMPTY_DIRECTORY,
        ...(gateDiff === undefined ? {} : { gateDiff }),
        ...(normalized === undefined ? {} : { normalized }),
        ...(readback === undefined ? {} : { readback }),
        readWarnings: parsed.read ?? [],
        writeWarnings: parsed.write ?? [],
      };
    });
}

describe('confluence storage fixtures', () => {
  const fixtures = loadFixtures();

  it('cover the dialect table', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(30);
  });

  describe.each(fixtures.filter((f) => f.direction !== 'write'))('$name (read)', (fixture) => {
    const result = storageToMdast(fixture.storage, { users: fixture.users });

    it('converts storage to the canonical markdown', () => {
      expect(stringifyConfluenceMarkdown(result.tree)).toBe(fixture.markdown);
    });

    it('has canonical markdown (stringify ∘ parse is the identity)', () => {
      expect(normalizeConfluenceMarkdown(fixture.markdown)).toBe(fixture.markdown);
    });

    it('emits exactly the expected read warnings', () => {
      expect(result.warnings).toEqual(fixture.readWarnings);
    });

    it('fences only exact slices of the source', () => {
      const fences = fixture.markdown.matchAll(/^```confluence\n([\s\S]*?)\n```$/gm);
      for (const fence of fences) expect(fixture.storage).toContain(fence[1]);
    });

    it.skipIf(fixture.normalized === undefined || !fixture.roundtrip)(
      'normalises to the same storage as its normalized form',
      () => {
        expect(normalizeStorage(fixture.storage)).toBe(normalizeStorage(fixture.normalized ?? ''));
      }
    );
  });

  describe.each(fixtures.filter((f) => f.direction !== 'read'))('$name (write)', (fixture) => {
    const writer: StorageWriterOptions = {
      ...DEFAULT_WRITER_OPTIONS,
      ...(fixture.writer as Partial<StorageWriterOptions>),
    };
    const converter = createStorageConverter({ users: fixture.users, writer });
    const expected = fixture.normalized ?? fixture.storage;

    it('converts the canonical markdown to the expected storage', () => {
      const result = markdownToStorage(fixture.markdown, { users: fixture.users, writer });
      expect(result.storage).toBe(expected);
      expect(
        result.warnings.map((w) => ({
          code: w.code,
          ...(w.line === undefined ? {} : { line: w.line }),
        }))
      ).toEqual(fixture.writeWarnings);
    });

    it('reads its own output back as the same markdown', () => {
      expect(converter.toMarkdown(converter.fromMarkdown(fixture.markdown))).toBe(
        fixture.readback ?? fixture.markdown
      );
    });

    it.skipIf(fixture.direction === 'write')('answers the fidelity gate as the notes say', () => {
      const result = checkFidelity(fixture.storage, converter);
      expect(result.error).toBeUndefined();
      expect(result.equal).toBe(fixture.roundtrip);
    });

    it.skipIf(fixture.gateDiff === undefined)('names the first node the gate refuses', () => {
      const result = checkFidelity(fixture.storage, converter);
      expect(result.diffs[0]?.path).toBe(fixture.gateDiff);
    });

    it.skipIf(fixture.direction === 'write' || !fixture.roundtrip)(
      'has a normalized form that is itself a fixed point',
      () => {
        const canonical = normalizeStorage(fixture.storage);
        expect(normalizeStorage(converter.fromMarkdown(converter.toMarkdown(canonical)))).toBe(
          canonical
        );
      }
    );

    it.skipIf(Object.keys(fixture.writer).length === 0)(
      'infers the writer options the notes declare from the storage shape',
      () => {
        const inferred = inferWriterOptions(
          storageToMdast(fixture.storage, { users: fixture.users }).shapes
        );
        for (const [key, value] of Object.entries(fixture.writer)) {
          expect(inferred[key as keyof StorageWriterOptions]).toBe(value);
        }
      }
    );
  });
});

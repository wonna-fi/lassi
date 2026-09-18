import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeMarkdown, splitFrontmatter } from '@wonna/lassi-core';
import { describe, expect, it } from 'vitest';
import { markdownToWiki, wikiToMarkdown } from './index.js';

const ROOT = fileURLToPath(new URL('../../../../fixtures/jira', import.meta.url));

interface ExpectedWarning {
  code: string;
  line?: number;
}

interface Fixture {
  name: string;
  wiki: string;
  markdown: string;
  direction: 'both' | 'read' | 'write';
  /** Expected write output when it legitimately differs from `wiki.txt`. */
  normalized?: string;
  /** Expected `wiki → md` result for write-only fixtures whose loop is lossy by design. */
  readback?: string;
  warnings: ExpectedWarning[];
}

function optional(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}

export function loadFixtures(): Fixture[] {
  return readdirSync(ROOT)
    .filter((name) => existsSync(join(ROOT, name, 'wiki.txt')))
    .sort()
    .map((name) => {
      const dir = join(ROOT, name);
      const notes = splitFrontmatter(readFileSync(join(dir, 'notes.md'), 'utf8'));
      const normalized = optional(join(dir, 'wiki.normalized.txt'));
      const readback = optional(join(dir, 'markdown.readback.md'));
      const warnings = optional(join(dir, 'warnings.json'));
      return {
        name,
        wiki: readFileSync(join(dir, 'wiki.txt'), 'utf8'),
        markdown: readFileSync(join(dir, 'markdown.md'), 'utf8'),
        direction: (notes.data?.['direction'] as Fixture['direction']) ?? 'both',
        ...(normalized === undefined ? {} : { normalized }),
        ...(readback === undefined ? {} : { readback }),
        warnings: warnings === undefined ? [] : (JSON.parse(warnings) as ExpectedWarning[]),
      };
    });
}

describe('jira wiki fixtures', () => {
  const fixtures = loadFixtures();

  it('cover the dialect table', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(20);
  });

  describe.each(fixtures.filter((f) => f.direction !== 'write'))('$name (read)', (fixture) => {
    it('converts wiki markup to the canonical markdown', () => {
      expect(wikiToMarkdown(fixture.wiki)).toBe(fixture.markdown);
    });

    it('has canonical markdown (stringify ∘ parse is the identity)', () => {
      expect(normalizeMarkdown(fixture.markdown)).toBe(fixture.markdown);
    });
  });

  describe.each(fixtures.filter((f) => f.direction !== 'read'))('$name (write)', (fixture) => {
    const expected = fixture.normalized ?? fixture.wiki;

    it('converts markdown to the expected wiki markup', () => {
      expect(markdownToWiki(fixture.markdown).wiki).toBe(expected);
    });

    it('emits exactly the expected warnings', () => {
      const actual = markdownToWiki(fixture.markdown).warnings.map(({ code, line }) =>
        line === undefined ? { code } : { code, line }
      );
      expect(actual).toEqual(fixture.warnings);
    });

    it('md → wiki → md is a fixed point', () => {
      expect(wikiToMarkdown(markdownToWiki(fixture.markdown).wiki)).toBe(
        fixture.readback ?? fixture.markdown
      );
    });

    it.skipIf(fixture.readback !== undefined)(
      'the expected wiki is itself stable under wiki → md → wiki',
      () => {
        expect(markdownToWiki(wikiToMarkdown(expected)).wiki).toBe(expected);
      }
    );
  });
});

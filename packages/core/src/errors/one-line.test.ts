import { describe, expect, it } from 'vitest';
import { LassiError } from './lassi-error.js';
import { toStderr } from './render.js';

describe('the stderr contract', () => {
  it('keeps the human part on one line whatever the message holds', () => {
    const err = new LassiError(
      'usage',
      'invalid configuration (~/.lassi.json):\n✖ Unrecognized key: "bogus"\n✖ must be an http(s) URL\n  → at jira.url'
    );
    const out = toStderr(err);
    const lines = out.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(
      'error: invalid configuration (~/.lassi.json): ✖ Unrecognized key: "bogus" ✖ must be an http(s) URL → at jira.url'
    );
    // The full text, newlines and all, is still in the JSON document.
    const parsed = JSON.parse(lines[1] as string) as { message: string };
    expect(parsed.message).toContain('\n');
  });

  it('does the same for a multi-line server body', () => {
    const err = new LassiError('http', '<html>\n<title>502 Bad Gateway</title>\n</html>', {
      http: 502,
    });
    const lines = toStderr(err)
      .split('\n')
      .filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('error: HTTP 502: <html> <title>502 Bad Gateway</title> </html>');
  });
});

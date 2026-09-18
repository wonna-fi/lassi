/**
 * A working-file body is the editable description followed by generated sections (`## Comments`,
 * `## Attachments`, `## Links`). These helpers keep the two apart so an update never sends the
 * generated part as content; both products use them.
 */

/** The generated tail of a working-file body, recorded in the cache so an update can cut it off. */
export function joinSections(sections: string[]): string {
  return sections
    .filter((s) => s.length > 0)
    .map((s) => s.trimEnd())
    .join('\n\n');
}

/** Body = description markdown + optional sections, separated by blank lines. */
export function composeBody(descriptionMarkdown: string, sections: string[]): string {
  const parts = [
    descriptionMarkdown.trimEnd(),
    ...sections.filter((s) => s.length > 0).map((s) => s.trimEnd()),
  ];
  return `${parts.filter((p) => p.length > 0).join('\n\n')}\n`;
}

/**
 * The description part of a working-file body whose tail is the generated `sections` from the
 * cache; `undefined` when that tail was edited, so the caller can refuse instead of sending
 * comment tables as the description.
 */
export function stripGeneratedSections(body: string, sections: string): string | undefined {
  const trimmed = body.trimEnd();
  if (sections.length === 0) return trimmed;
  // Deleting the tail and rewriting it look the same from here (a renamed heading is still an
  // edit), so neither is accepted; the caller tells the agent to re-fetch without the expansions.
  if (!trimmed.endsWith(sections)) return undefined;
  return trimmed.slice(0, trimmed.length - sections.length).trimEnd();
}

/** Which sections a cached body carried, so a rewrite after an update keeps the file's shape. */
export function expansionFromSections(sections: string): {
  comments: boolean;
  attachments: boolean;
  links: boolean;
} {
  return {
    comments: /^## Comments$/m.test(sections),
    attachments: /^## Attachments$/m.test(sections),
    links: /^## Links$/m.test(sections),
  };
}

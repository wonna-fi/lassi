---
title: Loss-Aware Conversion
type: pattern
sources:
  - packages/core/package.json
  - packages/core/src/index.ts
  - packages/core/src/markdown/*.ts
last_verified: 2026-09-19
---

# Loss-Aware Conversion

## When to Use

Use this pattern when adding or changing conversion between an external rich-text dialect and Lassi's Markdown. It applies when unsupported source must survive editing, output must reach a deterministic fixed point, and callers need actionable warnings instead of silent loss.

The canonical representation and raw-fence semantics belong to [Markdown Document](../concepts/markdown-document.md). Product-specific syntax belongs to the Jira and Confluence conversion features.

## Pattern

```typescript
import {
  LassiError,
  detectDialectLeak,
  isRawFence,
  leakMessage,
  parseMarkdown,
  rawFence,
  stringifyMarkdown,
  type BodyConverter,
} from '@wonna/lassi-core';
import type { Root } from 'mdast';

export const exampleConverter: BodyConverter = {
  format: 'wiki',

  toMarkdown(raw) {
    // 1. This minimal converter supports no source constructs, so preserve
    //    the complete input in the dialect's intentional raw fence.
    const tree: Root = { type: 'root', children: [rawFence('wiki', raw)] };

    // 2. Serialize through the shared canonical Markdown writer.
    return stringifyMarkdown(tree);
  },

  fromMarkdown(markdown) {
    // 3. Parse authored text through the one shared parser.
    const tree = parseMarkdown(markdown);

    // 4. Reject accidental source syntax outside intentional fences.
    const leaks = detectDialectLeak(tree);
    if (leaks.length > 0) throw new LassiError('validation', leakMessage(leaks));

    // 5. This converter can restore only the one shape it emits.
    const [source] = tree.children;
    if (tree.children.length !== 1 || source === undefined || !isRawFence(source, 'wiki')) {
      throw new LassiError('validation', 'This converter accepts one Jira raw fence.');
    }
    return source.value;
  },
};
```

This minimal example wraps source text in one raw fence and accepts that shape on return. Markdown parsing still applies its text rules, including replacement of NUL characters, so it is not a byte-preserving container. A product converter adds source parsing and writing while retaining raw fences for unsupported regions. Follow [TypeScript Modules](../conventions/typescript-modules.md) when adding the implementation.

## Key Points

- Convert source to mdast and mdast to source; do not create a separate Markdown grammar per product.
- Implement `BodyConverter.format`, `toMarkdown()`, and `fromMarkdown()` so callers stay dialect-neutral.
- Add matching parse and stringify extensions for every product node. A one-direction node cannot round-trip.
- Preserve unsupported source in a `jira` or `confluence` fence when it can be isolated meaningfully.
- Treat raw fences as an explicit escape hatch. Ordinary fenced code and inline code are not dialect leaks.
- Apply `autolinkLiterals()` to converter-built trees so bare URLs match parsed GFM.
- Serialize through `stringifyMarkdown()` for shared bullets, emphasis, tables, links, mentions, and newlines.
- Test a fixed point: canonical Markdown should equal `toMarkdown(fromMarkdown(md))` after normalization.
- Surface warnings when recovery is possible; throw a structured error when proceeding would reinterpret input.
- Use `detectDialectLeak()` before sending authored Markdown. It reports dialect, pattern, sample, and line.
- Preserve unsupported source before normalization. Formatting cannot recover a construct already discarded.
- Keep product lookup outside the generic parser. A mention may retain `userKey`; the product decides how to resolve it.

Determinism is part of the data contract. `normalizeMarkdown()` is `stringifyMarkdown(parseMarkdown(markdown))`; its writer merges adjacent equivalent emphasis spans, retains safe bare autolinks, escapes mention-like text, and chooses stable GFM spellings.

| Source case | Treatment |
|-------------|-----------|
| Known construct with a canonical mdast shape | Convert to the shared or product node. |
| Unknown block whose source can be retained | Emit a dialect raw fence and any product warning. |
| Authored dialect syntax outside a raw fence | Reject it and request GFM or an intentional fence. |
| Malformed source that cannot be safely bounded | Fail rather than invent content. |

Normalization preserves meaning, not cosmetic delimiter boundaries. Adjacent strong spans may become one rendered-equivalent span. Losing a macro or changing a link target is meaningful loss and must be fenced, warned about, or rejected.

Keep warning ownership at the narrowest useful layer. The converter identifies the construct and preservation outcome; the calling feature decides whether to print, aggregate, or promote that warning to a refusal. This keeps the generic Markdown package independent of Jira and Confluence command policy.

Before shipping a converter change, cover these invariants:

- source-to-Markdown output parses successfully through `parseMarkdown()`;
- normalized Markdown reaches a fixed point;
- supported nodes preserve their semantic fields in both directions;
- unsupported bounded source reappears inside the correct raw fence;
- intentional fences are accepted while the same source syntax in prose is rejected.

## Reference Implementations

| File | Function/Method | Notes |
| --- | --- | --- |
| `packages/core/src/markdown/parse.ts` | `parseMarkdown()` | One GFM, mention, and product-extension entry point. |
| `packages/core/src/markdown/stringify.ts` | `stringifyMarkdown()` | Canonical handling of links, underscores, and mentions. |
| `packages/core/src/markdown/raw-fence.ts` | `rawFence()` | Shared loss-preserving representation. |
| `packages/core/src/markdown/leak-detector.ts` | `detectDialectLeak()` | Rejects source syntax while respecting code boundaries. |
| `packages/core/src/markdown/autolink.ts` | `autolinkLiterals()` | Makes converter-built trees match parsed GFM. |

## Anti-Patterns

**Do NOT:**

- Convert with chained regular-expression replacements; nested rich text needs a tree.
- Drop an unknown element, macro, attribute, or wiki construct because Markdown lacks an equivalent.
- Put unsupported source in an unlabelled fence; the dialect label enables restoration.
- Accept Jira wiki or Confluence storage pasted into ordinary prose.
- Give each converter independent normalization rules.
- Promise byte-for-byte round trips where the contract is semantic equivalence plus passthrough.

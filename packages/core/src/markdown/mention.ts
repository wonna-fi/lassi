import type { Node } from 'unist';
import type { Extension as FromMarkdownExtension } from 'mdast-util-from-markdown';
import type { Options as ToMarkdownExtension } from 'mdast-util-to-markdown';
import { asciiAlphanumeric } from 'micromark-util-character';
import { codes } from 'micromark-util-symbol';
import type {
  Code,
  Construct,
  Extension,
  Previous,
  State,
  TokenizeContext,
  Tokenizer,
} from 'micromark-util-types';

/** `@username` in prose. Shared by both products; the serialisers validate the name. */
export interface Mention extends Node {
  type: 'mention';
  username: string;
  /** Confluence-only: set when read from `ri:userkey` and the key could not be resolved. */
  userKey?: string | undefined;
}

declare module 'mdast' {
  interface PhrasingContentMap {
    mention: Mention;
  }
  interface RootContentMap {
    mention: Mention;
  }
}

declare module 'micromark-util-types' {
  interface TokenTypeMap {
    mention: 'mention';
    mentionMarker: 'mentionMarker';
    mentionName: 'mentionName';
    mentionPunct: 'mentionPunct';
  }
}

function isNameChar(code: Code): boolean {
  return asciiAlphanumeric(code) || code === codes.underscore;
}

/**
 * A mention may not follow a word character, `@`, `.`, `/` or `-`, so e-mail addresses, paths
 * and `foo@bar` stay text. Escaped `\@` never reaches this construct (the character escape wins).
 */
const previous: Previous = function (code) {
  return (
    code === null ||
    !(
      isNameChar(code) ||
      code === codes.atSign ||
      code === codes.dot ||
      code === codes.slash ||
      code === codes.dash
    )
  );
};

/** `.` or `-` is part of the name only when a name character follows (so `@jsmith.` keeps the dot). */
const punctThenName: Construct = {
  partial: true,
  tokenize(effects, ok, nok) {
    return (code: Code): State | undefined => {
      effects.enter('mentionPunct');
      effects.consume(code);
      effects.exit('mentionPunct');
      return (next: Code): State | undefined => (isNameChar(next) ? ok(next) : nok(next));
    };
  },
};

const tokenizeMention: Tokenizer = function (this: TokenizeContext, effects, ok, nok) {
  let size = 0;

  const done = (code: Code): State | undefined => {
    if (size === 0) return nok(code);
    effects.exit('mentionName');
    effects.exit('mention');
    return ok(code);
  };

  const consumePunct = (code: Code): State | undefined => {
    effects.consume(code);
    size++;
    return inside;
  };

  const inside = (code: Code): State | undefined => {
    if (isNameChar(code)) {
      effects.consume(code);
      size++;
      return inside;
    }
    if ((code === codes.dot || code === codes.dash) && size > 0) {
      return effects.check(punctThenName, consumePunct, done)(code);
    }
    return done(code);
  };

  return (code: Code): State | undefined => {
    effects.enter('mention');
    effects.enter('mentionMarker');
    effects.consume(code);
    effects.exit('mentionMarker');
    effects.enter('mentionName');
    return inside;
  };
};

/** micromark syntax extension. */
export function mention(): Extension {
  return { text: { [codes.atSign]: { name: 'mention', tokenize: tokenizeMention, previous } } };
}

/** mdast-util-from-markdown extension. */
export function mentionFromMarkdown(): FromMarkdownExtension {
  return {
    enter: {
      mention(token) {
        this.enter({ type: 'mention', username: '' }, token);
      },
    },
    exit: {
      mentionName(token) {
        const node = this.stack[this.stack.length - 1] as Mention;
        node.username = this.sliceSerialize(token);
      },
      mention(token) {
        this.exit(token);
      },
    },
  };
}

/** mdast-util-to-markdown extension: emits `@name` and escapes literal text that would re-parse as one. */
export function mentionToMarkdown(): ToMarkdownExtension {
  return {
    handlers: {
      mention: (node: Mention) => `@${node.username}`,
    },
    unsafe: [
      {
        character: '@',
        inConstruct: 'phrasing',
        before: '(?:^|[^A-Za-z0-9_@./-])',
        after: '[A-Za-z0-9_]',
      },
    ],
  };
}

const MENTION_BEFORE = /[A-Za-z0-9_@./-]/;
const NAME_START = /[A-Za-z0-9_]/;

/**
 * mdast-util-to-markdown skips a `before`-conditioned escape when the previous character is itself
 * an unsafe one, even when that character is the enclosing construct's marker (`*@jsmith*`,
 * `[@jsmith](url)`), so the text handler re-applies the mention rule after `state.safe`.
 */
export function escapeMentionStarts(value: string, before: string): string {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i] as string;
    if (ch === '@') {
      const prev = i === 0 ? before.slice(-1) : (value[i - 1] as string);
      const next = value[i + 1];
      if (
        prev !== '\\' &&
        !(prev !== '' && MENTION_BEFORE.test(prev)) &&
        next !== undefined &&
        NAME_START.test(next)
      ) {
        out += '\\@';
        continue;
      }
    }
    out += ch;
  }
  return out;
}

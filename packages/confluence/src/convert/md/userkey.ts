import type { Mention } from '@wonna/lassi-core';
import type { Extension as FromMarkdownExtension } from 'mdast-util-from-markdown';
import type { Options as ToMarkdownExtension } from 'mdast-util-to-markdown';
import { asciiAlphanumeric } from 'micromark-util-character';
import { codes } from 'micromark-util-symbol';
import type {
  Code,
  Extension,
  Previous,
  State,
  TokenizeContext,
  Tokenizer,
} from 'micromark-util-types';

declare module 'micromark-util-types' {
  interface TokenTypeMap {
    userKeyMention: 'userKeyMention';
    userKeyMentionMarker: 'userKeyMentionMarker';
    userKeyMentionKey: 'userKeyMentionKey';
  }
}

const PREFIX = [...'{userkey:'].map((c) => c.charCodeAt(0));

/** Same left boundary as core's `@name`: not after a word character, `@`, `.`, `/` or `-`. */
const previous: Previous = function (code) {
  return (
    code === null ||
    !(
      asciiAlphanumeric(code) ||
      code === codes.underscore ||
      code === codes.atSign ||
      code === codes.dot ||
      code === codes.slash ||
      code === codes.dash
    )
  );
};

const tokenizeUserKey: Tokenizer = function (this: TokenizeContext, effects, ok, nok) {
  let at = 0;
  let size = 0;
  const key = (code: Code): State | undefined => {
    if (asciiAlphanumeric(code)) {
      effects.consume(code);
      size++;
      return key;
    }
    if (code === codes.rightCurlyBrace && size > 0) {
      effects.exit('userKeyMentionKey');
      effects.enter('userKeyMentionMarker');
      effects.consume(code);
      effects.exit('userKeyMentionMarker');
      effects.exit('userKeyMention');
      return ok;
    }
    return nok(code);
  };
  const prefix = (code: Code): State | undefined => {
    if (code !== PREFIX[at]) return nok(code);
    effects.consume(code);
    at++;
    if (at < PREFIX.length) return prefix;
    effects.exit('userKeyMentionMarker');
    effects.enter('userKeyMentionKey');
    return key;
  };
  return (code: Code): State | undefined => {
    effects.enter('userKeyMention');
    effects.enter('userKeyMentionMarker');
    effects.consume(code);
    return prefix;
  };
};

/**
 * `@{userkey:abc123}`: a Confluence user the directory could not resolve on read; it is written
 * back verbatim as `ri:userkey`. Registered after core's `@name`, which never matches `{`.
 */
export function userKeyMention(): Extension {
  return {
    text: { [codes.atSign]: { name: 'userKeyMention', tokenize: tokenizeUserKey, previous } },
  };
}

export function userKeyMentionFromMarkdown(): FromMarkdownExtension {
  return {
    enter: {
      userKeyMention(token) {
        this.enter({ type: 'mention', username: '', userKey: '' }, token);
      },
    },
    exit: {
      userKeyMentionKey(token) {
        (this.stack[this.stack.length - 1] as Mention).userKey = this.sliceSerialize(token);
      },
      userKeyMention(token) {
        this.exit(token);
      },
    },
  };
}

/** Overrides core's `mention` handler so an unresolved key keeps its placeholder form. */
export function userKeyMentionToMarkdown(): ToMarkdownExtension {
  return {
    handlers: {
      mention(node: Mention): string {
        return node.username ? `@${node.username}` : `@{userkey:${node.userKey ?? ''}}`;
      },
    },
    unsafe: [{ character: '@', inConstruct: 'phrasing', after: '\\{userkey:' }],
  };
}

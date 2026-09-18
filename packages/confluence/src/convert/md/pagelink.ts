import type { Extension as FromMarkdownExtension } from 'mdast-util-from-markdown';
import type { Options as ToMarkdownExtension } from 'mdast-util-to-markdown';
import { markdownLineEnding } from 'micromark-util-character';
import { codes } from 'micromark-util-symbol';
import type {
  Code,
  Construct,
  Extension,
  State,
  TokenizeContext,
  Tokenizer,
} from 'micromark-util-types';
import type { Node } from 'unist';

/** `[[Title]]`, `[[SPACE:Title]]`, `[[SPACE:Title|link text]]`; `space: ''` means "this space". */
export interface PageLink extends Node {
  type: 'pageLink';
  space?: string | undefined;
  title: string;
  body?: string | undefined;
}

declare module 'mdast' {
  interface PhrasingContentMap {
    pageLink: PageLink;
  }
  interface RootContentMap {
    pageLink: PageLink;
  }
}

declare module 'micromark-util-types' {
  interface TokenTypeMap {
    pageLink: 'pageLink';
    pageLinkMarker: 'pageLinkMarker';
    pageLinkBody: 'pageLinkBody';
  }
}

const SPACE_TITLE = /^(~?[A-Za-z0-9_.-]*):(\S.*)$/;

export function parsePageLinkBody(raw: string): Omit<PageLink, 'type'> {
  const bar = raw.indexOf('|');
  const target = bar === -1 ? raw : raw.slice(0, bar);
  const body = bar === -1 ? undefined : raw.slice(bar + 1);
  const m = SPACE_TITLE.exec(target);
  const out: Omit<PageLink, 'type'> = m
    ? { space: m[1] as string, title: m[2] as string }
    : { title: target };
  if (body !== undefined) out.body = body;
  return out;
}

/** Two closing brackets, checked without consuming. */
const closer: Construct = {
  partial: true,
  tokenize(effects, ok, nok) {
    return (code: Code): State | undefined => {
      if (code !== codes.rightSquareBracket) return nok(code);
      effects.consume(code);
      return (next: Code): State | undefined => {
        if (next !== codes.rightSquareBracket) return nok(next);
        effects.consume(next);
        return ok;
      };
    };
  },
};

const tokenizePageLink: Tokenizer = function (this: TokenizeContext, effects, ok, nok) {
  let size = 0;

  const closeSecond = (code: Code): State | undefined => {
    effects.consume(code);
    effects.exit('pageLinkMarker');
    effects.exit('pageLink');
    return ok;
  };
  const atClose = (code: Code): State | undefined => {
    if (size === 0) return nok(code);
    effects.exit('pageLinkBody');
    effects.enter('pageLinkMarker');
    effects.consume(code);
    return closeSecond;
  };
  const consumeBody = (code: Code): State | undefined => {
    effects.consume(code);
    size++;
    return inside;
  };
  const inside = (code: Code): State | undefined => {
    if (code === codes.eof || markdownLineEnding(code)) return nok(code);
    if (code === codes.rightSquareBracket) return effects.check(closer, atClose, consumeBody)(code);
    return consumeBody(code);
  };
  const second = (code: Code): State | undefined => {
    if (code !== codes.leftSquareBracket) return nok(code);
    effects.consume(code);
    effects.exit('pageLinkMarker');
    effects.enter('pageLinkBody');
    return inside;
  };
  return (code: Code): State | undefined => {
    effects.enter('pageLink');
    effects.enter('pageLinkMarker');
    effects.consume(code);
    return second;
  };
};

/** micromark syntax extension; registered before the built-in label start so `[[` wins. */
export function pageLink(): Extension {
  return {
    text: {
      [codes.leftSquareBracket]: { name: 'pageLink', tokenize: tokenizePageLink, add: 'before' },
    },
  };
}

export function pageLinkFromMarkdown(): FromMarkdownExtension {
  return {
    enter: {
      pageLink(token) {
        this.enter({ type: 'pageLink', title: '' }, token);
      },
    },
    exit: {
      pageLinkBody(token) {
        const node = this.stack[this.stack.length - 1] as PageLink;
        Object.assign(node, parsePageLinkBody(this.sliceSerialize(token)));
      },
      pageLink(token) {
        this.exit(token);
      },
    },
  };
}

/** `[[…]]`; a bare title that itself looks like `SPACE:Title` gets a leading `:` guard. */
export function pageLinkToMarkdown(): ToMarkdownExtension {
  return {
    handlers: {
      pageLink(node: PageLink): string {
        const prefix =
          node.space !== undefined ? `${node.space}:` : SPACE_TITLE.test(node.title) ? ':' : '';
        return `[[${prefix}${node.title}${node.body === undefined ? '' : `|${node.body}`}]]`;
      },
    },
  };
}

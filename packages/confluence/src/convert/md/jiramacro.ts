import type { Extension as FromMarkdownExtension } from 'mdast-util-from-markdown';
import type { Options as ToMarkdownExtension } from 'mdast-util-to-markdown';
import { asciiDigit, markdownLineEnding, markdownSpace } from 'micromark-util-character';
import { codes } from 'micromark-util-symbol';
import type { Code, Extension, State, TokenizeContext, Tokenizer } from 'micromark-util-types';
import type { Node } from 'unist';
import { decodeParams, encodeParams, type Params } from '../params.js';

/** `{jira:PROJ-1}` or `{jira:PROJ-1 serverId=abc}`: the Confluence jira macro for one issue. */
export interface JiraMacro extends Node {
  type: 'jiraMacro';
  key: string;
  params: Params;
}

declare module 'mdast' {
  interface PhrasingContentMap {
    jiraMacro: JiraMacro;
  }
  interface RootContentMap {
    jiraMacro: JiraMacro;
  }
}

declare module 'micromark-util-types' {
  interface TokenTypeMap {
    jiraMacro: 'jiraMacro';
    jiraMacroMarker: 'jiraMacroMarker';
    jiraMacroPrefix: 'jiraMacroPrefix';
    jiraMacroKey: 'jiraMacroKey';
    jiraMacroParams: 'jiraMacroParams';
  }
}

const PREFIX = [...'jira:'].map((c) => c.charCodeAt(0));

function upper(code: Code): boolean {
  return code !== null && code >= 65 && code <= 90;
}
function keyChar(code: Code): boolean {
  return upper(code) || asciiDigit(code) || code === codes.underscore;
}

const tokenizeJiraMacro: Tokenizer = function (this: TokenizeContext, effects, ok, nok) {
  let at = 0;

  const close = (code: Code): State | undefined => {
    effects.enter('jiraMacroMarker');
    effects.consume(code);
    effects.exit('jiraMacroMarker');
    effects.exit('jiraMacro');
    return ok;
  };
  const params = (code: Code): State | undefined => {
    if (code === codes.eof || markdownLineEnding(code)) return nok(code);
    if (code === codes.rightCurlyBrace) {
      effects.exit('jiraMacroParams');
      return close(code);
    }
    effects.consume(code);
    return params;
  };
  const afterNumber = (code: Code): State | undefined => {
    if (asciiDigit(code)) {
      effects.consume(code);
      return afterNumber;
    }
    if (code === codes.rightCurlyBrace) {
      effects.exit('jiraMacroKey');
      return close(code);
    }
    if (markdownSpace(code)) {
      effects.exit('jiraMacroKey');
      effects.enter('jiraMacroParams');
      effects.consume(code);
      return params;
    }
    return nok(code);
  };
  const number = (code: Code): State | undefined => {
    if (!asciiDigit(code)) return nok(code);
    effects.consume(code);
    return afterNumber;
  };
  const project = (code: Code): State | undefined => {
    if (keyChar(code)) {
      effects.consume(code);
      return project;
    }
    if (code === codes.dash) {
      effects.consume(code);
      return number;
    }
    return nok(code);
  };
  const keyStart = (code: Code): State | undefined => {
    if (!upper(code)) return nok(code);
    effects.enter('jiraMacroKey');
    effects.consume(code);
    return project;
  };
  const prefix = (code: Code): State | undefined => {
    if (code !== PREFIX[at]) return nok(code);
    effects.consume(code);
    at++;
    if (at < PREFIX.length) return prefix;
    effects.exit('jiraMacroPrefix');
    return keyStart;
  };
  return (code: Code): State | undefined => {
    effects.enter('jiraMacro');
    effects.enter('jiraMacroMarker');
    effects.consume(code);
    effects.exit('jiraMacroMarker');
    effects.enter('jiraMacroPrefix');
    return prefix;
  };
};

export function jiraMacro(): Extension {
  return { text: { [codes.leftCurlyBrace]: { name: 'jiraMacro', tokenize: tokenizeJiraMacro } } };
}

export function jiraMacroFromMarkdown(): FromMarkdownExtension {
  return {
    enter: {
      jiraMacro(token) {
        this.enter({ type: 'jiraMacro', key: '', params: [] }, token);
      },
    },
    exit: {
      jiraMacroKey(token) {
        (this.stack[this.stack.length - 1] as JiraMacro).key = this.sliceSerialize(token);
      },
      jiraMacroParams(token) {
        (this.stack[this.stack.length - 1] as JiraMacro).params =
          decodeParams(this.sliceSerialize(token).trim()) ?? [];
      },
      jiraMacro(token) {
        this.exit(token);
      },
    },
  };
}

export function jiraMacroToMarkdown(): ToMarkdownExtension {
  return {
    handlers: {
      jiraMacro(node: JiraMacro): string {
        const params = node.params.length > 0 ? ` ${encodeParams(node.params)}` : '';
        return `{jira:${node.key}${params}}`;
      },
    },
    unsafe: [{ character: '{', inConstruct: 'phrasing', after: 'jira:' }],
  };
}

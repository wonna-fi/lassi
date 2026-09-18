export type ConverterWarningCode =
  | 'inline-unknown'
  | 'attribute-unknown'
  | 'table-shape'
  | 'block-unknown'
  | 'user-unresolved';

/** One raw fence or placeholder the reader had to emit; the smoke histogram is built from these. */
export interface ConverterWarning {
  code: ConverterWarningCode;
  /** Element or macro name (`ac:emoticon`, `span[style]`, `macro:status`, `colspan`). */
  name: string;
  /** Positional XPath of the fenced node. */
  path: string;
}

export type StorageWarningCode =
  | 'code-meta-dropped'
  | 'image-title-dropped'
  | 'toc-params-dropped'
  | 'reference-consumed'
  | 'link-label-flattened';

/** A lossy-but-legal decision of the writer; the CLI prints them, library users receive them. */
export interface StorageWarning {
  code: StorageWarningCode;
  message: string;
  /** Source line of the markdown node, when the tree came from a parse. */
  line?: number;
}

interface Positioned {
  position?: { start: { line: number } } | undefined;
}

export class StorageWarnings {
  readonly list: StorageWarning[] = [];

  add(code: StorageWarningCode, message: string, node?: Positioned): void {
    const line = node?.position?.start.line;
    this.list.push({ code, message, ...(line === undefined ? {} : { line }) });
  }
}

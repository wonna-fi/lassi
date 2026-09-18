export type WikiWarningCode =
  | 'list-split'
  | 'list-start-dropped'
  | 'task-marker-ambiguity'
  | 'link-title-dropped'
  | 'link-label-flattened'
  | 'code-meta-dropped'
  | 'code-closer-in-body'
  | 'backslash-entity'
  | 'quote-flattened'
  | 'empty-heading';

export interface WikiWarning {
  code: WikiWarningCode;
  message: string;
  /** Source line of the markdown node, when the tree came from a parse. */
  line?: number;
}

interface Positioned {
  position?: { start: { line: number } } | undefined;
}

/** Collects lossy-but-legal decisions; the CLI prints them, library users receive them. */
export class Warnings {
  readonly list: WikiWarning[] = [];

  add(code: WikiWarningCode, message: string, node?: Positioned): void {
    const line = node?.position?.start.line;
    this.list.push({ code, message, ...(line === undefined ? {} : { line }) });
  }
}

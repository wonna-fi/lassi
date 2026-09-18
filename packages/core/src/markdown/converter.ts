export type Dialect = 'wiki' | 'storage';

/** converters sit behind this interface so ADF can be added later without touching the CLI. */
export interface BodyConverter {
  readonly format: Dialect;
  toMarkdown(raw: string): string;
  fromMarkdown(markdown: string): string;
}

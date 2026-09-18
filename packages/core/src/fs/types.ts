export interface FileStat {
  mode: number;
  mtimeMs: number;
  size: number;
  isDirectory: boolean;
}

/**
 * The only filesystem surface the libraries and the CLI use. Injected everywhere so tests run on an
 * in-memory implementation (`memFs` in `@wonna/lassi-core/testing`) and non-CLI consumers can
 * supply their own.
 */
export interface LassiFs {
  readFile(path: string): Promise<string>;
  /** Raw bytes, for uploads; `readFile` decodes UTF-8. */
  readBytes(path: string): Promise<Uint8Array>;
  /** Creates parent directories as needed. */
  writeFile(path: string, data: string): Promise<void>;
  /** Atomic creation; rejects with EEXIST rather than replacing an existing file. */
  writeFileExclusive(path: string, data: string): Promise<void>;
  /** Raw bytes (index vectors, downloaded blobs); creates parent directories as needed. */
  writeBytes(path: string, data: Uint8Array): Promise<void>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<FileStat>;
  /** Recursive. */
  mkdir(path: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  copyFile(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** The path with every symlink followed; rejects when it does not exist. */
  realpath(path: string): Promise<string>;
}

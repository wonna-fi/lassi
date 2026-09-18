export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

const ORDER: Record<LogLevel, number> = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

export interface Logger {
  readonly level: LogLevel;
  error(message: string): void;
  warn(message: string): void;
  info(message: string): void;
  debug(message: string): void;
}

export interface LoggerOptions {
  level: LogLevel;
  /** Receives complete lines including the trailing newline; the CLI passes `stderr.write`. */
  write: (line: string) => void;
  redact?: (text: string) => string;
}

/** Plain `level: message` lines, no colour, meant for stderr. Every line passes the redactor. */
export function createLogger(opts: LoggerOptions): Logger {
  const redact = opts.redact ?? ((s: string) => s);
  const threshold = ORDER[opts.level];
  const emit = (level: Exclude<LogLevel, 'silent'>, message: string): void => {
    if (ORDER[level] > threshold) return;
    opts.write(`${level}: ${redact(message)}\n`);
  };
  return {
    level: opts.level,
    error: (m) => emit('error', m),
    warn: (m) => emit('warn', m),
    info: (m) => emit('info', m),
    debug: (m) => emit('debug', m),
  };
}

export const silentLogger: Logger = createLogger({ level: 'silent', write: () => {} });

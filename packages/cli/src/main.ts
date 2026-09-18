import { realDeps } from './deps.js';
import { runCli } from './run.js';

// process.exitCode (not process.exit) lets stdout flush on Windows pipes.
runCli(process.argv.slice(2), realDeps()).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
);

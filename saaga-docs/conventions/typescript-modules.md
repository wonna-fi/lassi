---
title: TypeScript Modules
type: convention
---

# TypeScript Modules

- **Rule.** Write TypeScript as ESM and include the emitted `.js` extension in every relative import.
- **Do.** `import { readIndex } from './index/store.js';`
- **Don't.** `import { readIndex } from './index/store';`
- **Rule.** Expose a package's public API through `src/index.ts`; do not make consumers import internal source paths.
- **Do.** Re-export a public symbol from `src/index.ts`, then import it from `@wonna/lassi-core`.
- **Don't.** Import it from `@wonna/lassi-core/src/config/load.js`.
- **Rule.** Mark imports used only as types with `import type` or an inline `type` specifier.
- **Do.** `import type { LassiFs } from '@wonna/lassi-core';`
- **Don't.** `import { LassiFs } from '@wonna/lassi-core';`
- **Applies to.** `packages/*/src/**/*.ts`

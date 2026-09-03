/**
 * Node test runner hooks so `src/lib/*.test.ts` can import project modules
 * the way Vite does: extensionless relative imports and the `@/` alias.
 *
 *   node --experimental-strip-types --import ./scripts/test-loader.mjs --test src/lib/*.test.ts
 */
import { register } from "node:module";

register("./test-resolver.mjs", import.meta.url);

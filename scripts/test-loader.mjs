/**
 * Node test runner hooks so a workspace's `*.test.ts` can import project modules
 * the way Vite does: extensionless relative imports and the `@/` alias (relative
 * to the workspace's cwd).
 *
 *   node --experimental-strip-types --import ../../scripts/test-loader.mjs --test src/*.test.ts
 */
import { register } from "node:module";

register("./test-resolver.mjs", import.meta.url);

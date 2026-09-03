import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const EXTS = [".ts", ".tsx", ".mts", ".js", ".mjs"];

function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function withExtension(path) {
  if (isFile(path)) return path;
  for (const ext of EXTS) {
    if (isFile(path + ext)) return path + ext;
  }
  for (const ext of EXTS) {
    const idx = join(path, `index${ext}`);
    if (isFile(idx)) return idx;
  }
  return null;
}

export async function resolve(specifier, context, next) {
  let path = null;
  if (specifier.startsWith("@/")) {
    path = join(ROOT, "src", specifier.slice(2));
  } else if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const parent = context.parentURL ? fileURLToPath(context.parentURL) : join(ROOT, "x");
    path = resolvePath(dirname(parent), specifier);
  }
  if (path && existsSync(dirname(path))) {
    const hit = withExtension(path);
    if (hit) return next(pathToFileURL(hit).href, context);
  }
  return next(specifier, context);
}

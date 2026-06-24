import { cp, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "src/browser-assets");
const target = resolve(root, "dist/browser-assets");

await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true, force: true });

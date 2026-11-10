// Bettet packages/core/wasm/wterm.wasm als Base64 in packages/core/src/wasm-inline.ts ein
// (entspricht packages/@wterm/core/scripts/inline-wasm.js im Original-Repo).
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const wasm = readFileSync(join(root, "packages/core/wasm/wterm.wasm"));
writeFileSync(
  join(root, "packages/core/src/wasm-inline.ts"),
  `// Auto-generated — do not edit. Run \`npm run inline-wasm\` to regenerate.\nexport const WASM_BASE64 = "${wasm.toString("base64")}";\n`,
);

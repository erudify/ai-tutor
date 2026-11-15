import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { parseLookup } from "../src/corpus/cedict";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function writeLookup(): Promise<void> {
  const cedict = gunzipSync(
    readFileSync(resolve(root, "vendor/cc-cedict/cedict_1_0_ts_utf-8_mdbg.txt.gz")),
  ).toString("utf8");
  const dictionary = parseLookup(cedict);
  const entries: Record<string, [string, string][]> = {};
  let readings = 0;
  for (const [hanzi, senses] of dictionary) {
    entries[hanzi] = senses.map((sense) => [sense.pinyin, sense.gloss]);
    readings += senses.length;
  }
  const jsonPath = resolve(root, "public/dict.json");
  mkdirSync(dirname(jsonPath), { recursive: true });
  writeFileSync(jsonPath, JSON.stringify(entries));
  await build({
    entryPoints: [resolve(root, "src/corpus/lookup.ts")],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    outfile: resolve(root, "public/lookup.js"),
    banner: { js: "/* Generated from src/corpus/lookup.ts. */" },
  });
  const bytes = statSync(jsonPath).size;
  console.log(
    `lookup words ${dictionary.size}, readings ${readings}, dict.json ${bytes} bytes`,
  );
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  writeLookup().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}

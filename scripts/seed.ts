import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCorpus, type BuiltSentence, type BuiltWord } from "../src/corpus/build";
import { writeLookup } from "./dict";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const wrangler = resolve(root, "node_modules/wrangler/bin/wrangler.js");

function sqlText(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function sqlValue(value: string | number | null): string {
  if (value === null) return "NULL";
  if (typeof value === "number") return String(value);
  return sqlText(value);
}

function inserts(
  table: string,
  columns: readonly string[],
  rows: readonly (readonly (string | number | null)[])[],
): string {
  const statements: string[] = [];
  const size = 20;
  for (let i = 0; i < rows.length; i += size) {
    const chunk = rows.slice(i, i + size);
    const values = chunk
      .map((row) => `(${row.map((cell) => sqlValue(cell)).join(", ")})`)
      .join(",\n");
    statements.push(`INSERT INTO ${table} (${columns.join(", ")}) VALUES\n${values};`);
  }
  return statements.join("\n");
}

function wordRow(word: BuiltWord): (string | number | null)[] {
  return [
    word.hanzi,
    word.pinyin,
    word.gloss,
    word.level,
    word.ord,
    word.curriculum ? 1 : 0,
    word.exampleHanzi,
    word.examplePinyin,
    word.exampleEnglish,
  ];
}

function sentenceRow(sentence: BuiltSentence): (string | number | null)[] {
  return [sentence.id, sentence.hanzi, sentence.pinyin, sentence.english];
}

async function main(): Promise<void> {
  await writeLookup();
  const levels = [1, 2, 3, 4].map((level) => ({
    level,
    text: readFileSync(
      resolve(root, `vendor/haoxue-public/gpt_sentences_hsk_${level}.txt`),
      "utf8",
    ),
  }));
  const cedict = gunzipSync(
    readFileSync(resolve(root, "vendor/cc-cedict/cedict_1_0_ts_utf-8_mdbg.txt.gz")),
  ).toString("utf8");
  const corpus = buildCorpus(levels, cedict);
  const sql = [
    "DELETE FROM sentences;",
    "DELETE FROM words;",
    inserts(
      "words",
      [
        "hanzi",
        "pinyin",
        "gloss",
        "level",
        "ord",
        "curriculum",
        "example_hanzi",
        "example_pinyin",
        "example_english",
      ],
      corpus.words.map(wordRow),
    ),
    inserts(
      "sentences",
      ["id", "hanzi", "pinyin", "english"],
      corpus.sentences.map(sentenceRow),
    ),
  ].join("\n");
  const out = resolve(root, "corpus/seed.sql");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, sql);
  const curriculum = corpus.words.filter((word) => word.curriculum).length;
  console.log(
    `words ${corpus.words.length}, curriculum ${curriculum}, sentences ${corpus.sentences.length}`,
  );
  runWrangler(["d1", "migrations", "apply", "erudify-corpus", "--local"]);
  runWrangler(["d1", "execute", "erudify-corpus", "--local", `--file=${out}`]);
}

function runWrangler(args: readonly string[]): void {
  const output = execFileSync(process.execPath, [wrangler, ...args], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  const notable = output
    .split("\n")
    .filter((line) => /executed successfully|✅|error|Error|Migration/i.test(line));
  console.log(
    notable.length > 0
      ? notable.join("\n")
      : output.trim().split("\n").slice(-8).join("\n"),
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

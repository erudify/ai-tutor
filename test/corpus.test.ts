import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildCorpus, type BuiltCorpus } from "../src/corpus/build";
import { curriculumTokens, pickExample } from "../src/corpus/examples";
import { indexCorpus } from "../src/corpus/model";
import { parseSentenceFile } from "../src/corpus/parse";
import { Segmenter } from "../src/corpus/segment";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function curriculumKey(built: BuiltCorpus): string[] {
  return built.words
    .filter((word) => word.curriculum)
    .sort((left, right) => (left.ord ?? 0) - (right.ord ?? 0))
    .map(
      (word) =>
        `${word.ord}\t${word.hanzi}\t${word.exampleHanzi}\t${word.examplePinyin}\t${word.exampleEnglish}`,
    );
}

function reverseSentences(text: string): string {
  return parseSentenceFile(text)
    .reverse()
    .map(
      (sentence) =>
        `Chinese: ${sentence.hanzi}\nPinyin: ${sentence.pinyin}\nEnglish: ${sentence.english}`,
    )
    .join("\n\n");
}

describe("vendored curriculum", () => {
  it("orders sentences so every curriculum word has an earlier example", () => {
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
    const built = buildCorpus(levels, cedict);
    const reversed = buildCorpus(
      levels.map((file) => ({ ...file, text: reverseSentences(file.text) })),
      cedict,
    );
    expect(curriculumKey(reversed)).toEqual(curriculumKey(built));
    const corpus = indexCorpus(built.words, built.sentences);
    const curriculum = new Set(corpus.curriculum.map((word) => word.hanzi));
    const head = corpus.curriculum
      .slice(0, 12)
      .map((word) => `${word.hanzi} ${word.exampleHanzi}`)
      .join(" | ");

    expect(
      corpus.curriculum.slice(0, 5).map((word) => word.hanzi),
      head,
    ).toEqual(["的", "我", "是", "这", "书"]);
    expect(corpus.curriculum[0]?.exampleHanzi).toBe("这是我的书。");
    expect(corpus.byHanzi.get("喜欢")?.curriculum).toBe(true);
    for (const hanzi of ["饺子", "蓝色", "鼻子", "考虑", "阿姨"]) {
      expect(curriculum.has(hanzi), hanzi).toBe(true);
    }
    const parts = corpus.segmenter
      .segment("我喜欢吃饺子")
      .filter((part) => part.kind === "word")
      .map((part) => part.hanzi);
    expect(parts).toContain("喜欢");
    expect(parts).toContain("饺子");
    corpus.curriculum.forEach((word, index) => {
      expect(word.ord, word.hanzi).toBe(index);
      expect(word.exampleHanzi.includes(word.hanzi), word.hanzi).toBe(true);
      expect(word.exampleLimit, word.hanzi).not.toBeNull();
    });
    const segmenter = new Segmenter(corpus.curriculum.map((word) => word.hanzi));
    const ordOf = (hanzi: string) => corpus.byHanzi.get(hanzi)?.ord ?? null;
    for (const word of corpus.curriculum) {
      const tokens = curriculumTokens(segmenter, word.exampleHanzi);
      expect(tokens, word.hanzi).not.toBeNull();
      for (const token of new Set(tokens ?? [])) {
        const ord = ordOf(token);
        expect(ord, `${word.hanzi} uses ${token}`).not.toBeNull();
        expect(ord ?? 0).toBeLessThanOrEqual(word.exampleLimit ?? 0);
      }
      const known = new Set(
        corpus.curriculum
          .filter((item) => (item.ord ?? 0) <= (word.exampleLimit ?? 0))
          .map((item) => item.hanzi),
      );
      const rich = pickExample(
        corpus.examplesByToken.get(word.hanzi) ?? [],
        word.hanzi,
        word.exampleLimit,
        ordOf,
        known,
      );
      if (!rich) continue;
      for (const token of new Set(rich.tokens)) {
        expect(ordOf(token) ?? 0).toBeLessThanOrEqual(word.exampleLimit ?? 0);
      }
    }
  }, 180_000);
});

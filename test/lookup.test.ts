import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseCedict, parseLookup } from "../src/corpus/cedict";
import { segmentLookup } from "../src/corpus/lookup";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const FIXTURE = `
# comment
行 行 [xing2] /to walk/to go/to travel/
行 行 [hang2] /a row/a line/
行 行 [hang2] /a row again/
十 十 [shi2] /ten/10/
一二三四五六七八九 一二三四五六七八九 [yi1] /nine characters/
Latin x [eks1] /not hanzi/
`;

function wordsOf(text: string): string[] {
  return segmentLookup(text, WORDS)
    .filter((piece) => piece.kind === "word")
    .map((piece) => piece.hanzi);
}

const WORDS = new Set([
  "十",
  "分",
  "钟",
  "十分",
  "分钟",
  "钟爱",
  "研究",
  "研究生",
  "生命",
  "命",
  "起源",
  "他",
  "说",
  "的",
  "的确",
  "确实",
  "实在",
  "在理",
  "理",
  "等",
  "了",
]);

describe("segmentLookup", () => {
  it("prefers the cut that keeps a unit together", () => {
    expect(wordsOf("十分钟")).toEqual(["十", "分钟"]);
    expect(wordsOf("十分钟爱")).toEqual(["十分", "钟爱"]);
    expect(wordsOf("研究生命起源")).toEqual(["研究", "生命", "起源"]);
    expect(wordsOf("他说的确实在理")).toEqual(["他", "说", "的", "确实", "在理"]);
  });

  it("leaves punctuation outside the words", () => {
    expect(segmentLookup("等了十分钟。", WORDS)).toEqual([
      { kind: "word", hanzi: "等" },
      { kind: "word", hanzi: "了" },
      { kind: "word", hanzi: "十" },
      { kind: "word", hanzi: "分钟" },
      { kind: "text", text: "。" },
    ]);
  });
});

describe("parseLookup", () => {
  it("keeps every reading and headwords the curriculum parser drops", () => {
    const lookup = parseLookup(FIXTURE);
    const curriculum = parseCedict(FIXTURE);
    expect(lookup.get("行")).toEqual([
      { pinyin: "xíng", gloss: "to walk; to go" },
      { pinyin: "háng", gloss: "a row; a line" },
    ]);
    expect(lookup.get("一二三四五六七八九")).toEqual([
      { pinyin: "yī", gloss: "nine characters" },
    ]);
    expect(lookup.has("x")).toBe(false);
    expect(curriculum.get("行")).toEqual({ pinyin: "xíng", gloss: "to walk; to go" });
    expect(curriculum.has("一二三四五六七八九")).toBe(false);
  });
});

describe("vendored lookup dictionary", () => {
  it("cuts the real CC-CEDICT entries", () => {
    const text = gunzipSync(
      readFileSync(resolve(root, "vendor/cc-cedict/cedict_1_0_ts_utf-8_mdbg.txt.gz")),
    ).toString("utf8");
    const dictionary = parseLookup(text);
    const words = new Set(dictionary.keys());
    const cut = (value: string) =>
      segmentLookup(value, words)
        .filter((piece) => piece.kind === "word")
        .map((piece) => piece.hanzi);
    expect(cut("十分钟")).toEqual(["十", "分钟"]);
    expect(cut("十分钟爱")).toEqual(["十分", "钟爱"]);
    expect(cut("研究生命起源")).toEqual(["研究", "生命", "起源"]);
    expect(cut("他说的确实在理")).toEqual(["他", "说", "的", "确实", "在理"]);
    const hang = dictionary.get("行")?.map((reading) => reading.pinyin) ?? [];
    expect(hang).toContain("xíng");
    expect(hang).toContain("háng");
  }, 60_000);
});

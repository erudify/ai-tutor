import { describe, expect, it } from "vitest";
import { indexCorpus } from "../src/corpus/model";
import type { BuiltWord } from "../src/corpus/build";
import { TUTOR_INSTRUCTIONS } from "../src/llm/prompts";
import { rulesLlm } from "../src/llm/rules";
import { formatPinyin } from "../src/corpus/cedict";
import { runTurn } from "../src/turn";

function word(
  partial: Pick<BuiltWord, "hanzi" | "gloss" | "ord" | "curriculum"> &
    Partial<BuiltWord>,
): BuiltWord {
  return {
    pinyin: partial.pinyin ?? "",
    level: partial.level ?? 1,
    exampleHanzi: partial.exampleHanzi ?? partial.hanzi,
    examplePinyin: partial.examplePinyin ?? "",
    exampleEnglish: partial.exampleEnglish ?? partial.gloss,
    ...partial,
  };
}

const corpus = indexCorpus(
  [
    word({
      hanzi: "我",
      gloss: "I",
      ord: 0,
      curriculum: true,
      exampleHanzi: "我是学生。",
      exampleEnglish: "I am a student.",
    }),
    word({
      hanzi: "饺子",
      gloss: "dumpling",
      ord: 1,
      curriculum: true,
      exampleHanzi: "我喜欢吃饺子。",
      exampleEnglish: "I like to eat dumplings.",
    }),
    word({
      hanzi: "蓝色",
      gloss: "blue",
      ord: 2,
      curriculum: true,
      exampleHanzi: "天空是蓝色的。",
      exampleEnglish: "The sky is blue.",
    }),
    word({ hanzi: "是", gloss: "to be", ord: null, curriculum: false, level: null }),
    word({ hanzi: "什么", gloss: "what", ord: null, curriculum: false, level: null }),
    word({
      hanzi: "意思",
      gloss: "meaning",
      ord: null,
      curriculum: false,
      level: null,
    }),
  ],
  [],
);

describe("runTurn with the rules tutor", () => {
  it("explains a meaning question and does not pivot to the scheduled sentence", async () => {
    const now = 1_700_000_000_000;
    const first = await runTurn({
      corpus,
      snapshot: { messages: [], cards: [] },
      studentText: "饺子是什么意思？",
      now,
      llm: rulesLlm(),
    });
    expect(first.trace.events).toEqual([
      expect.objectContaining({
        hanzi: "饺子",
        outcome: "unknown",
        ratingName: "again",
      }),
    ]);
    expect(first.reply).toContain("dumpling");
    expect(first.reply).not.toContain("我是学生");

    const second = await runTurn({
      corpus,
      snapshot: {
        messages: [
          { role: "user", content: "饺子是什么意思？" },
          { role: "assistant", content: first.reply },
        ],
        cards: first.cards,
      },
      studentText: "好",
      now,
      llm: rulesLlm(),
    });
    expect(second.reply).toContain("我是学生");
  });
});

describe("tutor instructions", () => {
  it("treats a suggestion as optional and names the 饺子 case", () => {
    expect(TUTOR_INSTRUCTIONS).toContain("饺子");
    expect(TUTOR_INSTRUCTIONS).toMatch(/not a script/i);
    expect(TUTOR_INSTRUCTIONS).toMatch(/never have to use it/i);
    expect(TUTOR_INSTRUCTIONS).toMatch(/number of known words is few/);
    expect(TUTOR_INSTRUCTIONS).toMatch(/Do not speak Chinese/);
    expect(TUTOR_INSTRUCTIONS).toMatch(/first language/);
    expect(TUTOR_INSTRUCTIONS).toContain("What do you think X means?");
    expect(TUTOR_INSTRUCTIONS).toMatch(/due now/);
    expect(TUTOR_INSTRUCTIONS).toMatch(/understand it in a sentence, or produce it/);
  });
});

describe("formatPinyin", () => {
  it("puts the tone mark on the right vowel", () => {
    expect(formatPinyin("ni3 hao3")).toBe("nǐ hǎo");
  });
});

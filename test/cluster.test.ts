import { describe, expect, it } from "vitest";
import { clusterSentences, upgradeHeadword } from "../src/corpus/cluster";
import type { RawSentence } from "../src/corpus/parse";

function sentence(hanzi: string): RawSentence {
  return { hanzi, pinyin: "x", english: "x" };
}

describe("clusterSentences", () => {
  it("recovers the shared headword of each example run", () => {
    const blue = [
      "天空是蓝色的。",
      "我喜欢蓝色。",
      "这是蓝色的笔。",
      "蓝色很漂亮。",
      "她穿着蓝色的衣服。",
    ];
    const socks = [
      "我买了新袜子。",
      "这双袜子是红的。",
      "袜子在椅子上。",
      "他洗了袜子。",
      "黑色的袜子很暖和。",
    ];
    const groups = clusterSentences([...blue, ...socks].map(sentence));
    expect(groups.map((group) => group.word)).toEqual(["蓝色", "袜子"]);
  });
});

describe("upgradeHeadword", () => {
  it("extends a shared character to the dictionary word that covers the run", () => {
    const sentences = [
      "我考虑一下。",
      "请考虑这个问题。",
      "他正在考虑。",
      "我们考虑过了。",
      "你考虑了吗？",
      "她没有考虑。",
      "再考虑考虑。",
      "老师让我考虑。",
      "好好考虑。",
      "这是深思熟虑。",
    ];
    const dictionary = new Set(["考虑", "深思熟虑"]);
    expect(upgradeHeadword("虑", sentences, dictionary)).toBe("考虑");
  });
});

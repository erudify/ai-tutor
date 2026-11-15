import { describe, expect, it } from "vitest";
import {
  orderSentences,
  pickExample,
  type IndexedExample,
} from "../src/corpus/examples";

const sentences: IndexedExample[] = [
  { hanzi: "我很好。", pinyin: "", english: "", tokens: ["我", "很", "好"] },
  { hanzi: "我是学生。", pinyin: "", english: "", tokens: ["我", "是", "学生"] },
  {
    hanzi: "我是好学生。",
    pinyin: "",
    english: "",
    tokens: ["我", "是", "好", "学生"],
  },
];

const sourceOrd = new Map([
  ["我", 0],
  ["很", 1],
  ["好", 2],
  ["是", 3],
  ["学生", 4],
]);

const ordOf = (hanzi: string): number | null =>
  ({ 我: 0, 很: 1, 好: 2, 是: 3, 学生: 4 })[hanzi] ?? null;

describe("sentence order", () => {
  it("introduces 我 with 很 and 好, and gives every word that sentence", () => {
    const placed = orderSentences(sentences, sourceOrd);
    expect(placed.map((item) => item.hanzi)).toEqual(["我", "很", "好", "是", "学生"]);
    expect(placed.find((item) => item.hanzi === "我")?.exampleHanzi).toBe("我很好。");
    expect(placed.find((item) => item.hanzi === "好")?.exampleHanzi).toBe("我很好。");
    expect(placed.find((item) => item.hanzi === "是")?.exampleHanzi).toBe("我是学生。");
    expect(placed.find((item) => item.hanzi === "学生")?.exampleHanzi).toBe(
      "我是学生。",
    );
    for (const item of placed) {
      expect(item.exampleHanzi.includes(item.hanzi)).toBe(true);
      expect(item.exampleHanzi).not.toBe(`${item.hanzi}。`);
    }
  });
});

describe("example sentences", () => {
  it("never uses a later sentence, and grows once the student knows more words", () => {
    const forMe = (known: string[]) =>
      pickExample(sentences, "我", 2, ordOf, new Set(known))?.hanzi;
    expect(forMe([])).toBe("我很好。");
    expect(forMe(["是", "学生"])).toBe("我很好。");

    const forStudent = (known: string[]) =>
      pickExample(sentences, "学生", 4, ordOf, new Set(known))?.hanzi;
    expect(forStudent([])).toBe("我是学生。");
    expect(forStudent(["我", "是", "好"])).toBe("我是好学生。");
  });
});

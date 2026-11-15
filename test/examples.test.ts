import { describe, expect, it } from "vitest";
import {
  orderSentences,
  pickExample,
  type ExampleCandidate,
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

const ordOf = (hanzi: string): number | null =>
  ({ 我: 0, 很: 1, 好: 2, 是: 3, 学生: 4 })[hanzi] ?? null;

function row(
  hanzi: string,
  tokens: string[],
  pinyin = "",
  english = "",
): ExampleCandidate {
  return { hanzi, pinyin, english, tokens };
}

describe("sentence order", () => {
  it("uses fewer new characters when the rarest new word is equally common", () => {
    const rows = [
      row("哎呀不客气。", ["哎呀", "不客气"]),
      row("丁。", ["丁"]),
      row("我。", ["我"]),
      row("我你。", ["我", "你"]),
      row("你。", ["你"]),
    ];
    const expectOrder = (placed: ReturnType<typeof orderSentences>) => {
      expect(placed.map((item) => `${item.hanzi} ${item.exampleHanzi}`)).toEqual([
        "你 你。",
        "我 我。",
        "丁 丁。",
        "哎呀 哎呀不客气。",
        "不客气 哎呀不客气。",
      ]);
    };
    expectOrder(orderSentences(rows));
    expectOrder(orderSentences([...rows].reverse()));
  });

  it("prefers a longer sentence whose rarest new word is more common", () => {
    const rows = [
      row("我的头疼。", ["我", "的", "头疼"]),
      row("这是我的书。", ["这", "是", "我", "的", "书"]),
      row("这是书。", ["这", "是", "书"]),
      row("我的笔。", ["我", "的", "笔"]),
    ];
    const placed = orderSentences(rows);
    expect(placed.map((item) => `${item.hanzi} ${item.exampleHanzi}`)).toEqual([
      "我 这是我的书。",
      "的 这是我的书。",
      "这 这是我的书。",
      "是 这是我的书。",
      "书 这是我的书。",
      "笔 我的笔。",
      "头疼 我的头疼。",
    ]);
    expect(orderSentences([...rows].reverse()).map((item) => item.hanzi)).toEqual(
      placed.map((item) => item.hanzi),
    );
  });

  it("keeps one copy of a repeated sentence, independent of input order", () => {
    const placed = orderSentences([
      row("丁。", ["丁"], "b", "z"),
      row("丁。", ["丁"], "a", "m"),
    ]);
    expect(placed).toEqual([
      {
        hanzi: "丁",
        ord: 0,
        exampleHanzi: "丁。",
        examplePinyin: "a",
        exampleEnglish: "m",
      },
    ]);
    expect(
      orderSentences([row("丁。", ["丁"], "a", "m"), row("丁。", ["丁"], "b", "z")]),
    ).toEqual(placed);
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

  it("breaks a tie by the sentence text", () => {
    const tied: IndexedExample[] = [
      { hanzi: "我很好。", pinyin: "", english: "", tokens: ["我", "很", "好"] },
      { hanzi: "我好很。", pinyin: "", english: "", tokens: ["我", "好", "很"] },
    ];
    const expected = ["我好很。", "我很好。"].sort((a, b) =>
      a.localeCompare(b, "zh"),
    )[0];
    expect(pickExample(tied, "我", 2, ordOf, new Set())?.hanzi).toBe(expected);
    expect(pickExample([...tied].reverse(), "我", 2, ordOf, new Set())?.hanzi).toBe(
      expected,
    );
  });
});

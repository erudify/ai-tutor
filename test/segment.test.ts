import { describe, expect, it } from "vitest";
import { Segmenter } from "../src/corpus/segment";

describe("Segmenter", () => {
  it("takes the longest dictionary word", () => {
    const segmenter = new Segmenter(["我", "喜欢", "吃", "饺子", "图书", "图书馆"]);
    expect(
      segmenter.segment("我喜欢吃饺子").filter((part) => part.kind === "word"),
    ).toEqual([
      { kind: "word", hanzi: "我" },
      { kind: "word", hanzi: "喜欢" },
      { kind: "word", hanzi: "吃" },
      { kind: "word", hanzi: "饺子" },
    ]);
    expect(segmenter.segment("图书馆")).toEqual([{ kind: "word", hanzi: "图书馆" }]);
  });
});

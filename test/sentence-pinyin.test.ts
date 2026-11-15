import { describe, expect, it } from "vitest";
import { alignSentencePinyin, pinyinSlice } from "../src/sentence-pinyin";

function reading(hanzi: string, pinyin: string, word: string): string | null {
  const spans = alignSentencePinyin(hanzi, pinyin);
  if (!spans) return null;
  const at = hanzi.indexOf(word);
  if (at < 0) return null;
  return pinyinSlice(pinyin, spans, at, at + word.length);
}

describe("alignSentencePinyin", () => {
  it("reads 要 as yào in 我们明天要去她家", () => {
    const hanzi = "我们明天要去她家。";
    const pinyin = "Wǒmen míngtiān yào qù tā jiā.";
    expect(reading(hanzi, pinyin, "要")).toBe("yào");
    expect(reading(hanzi, pinyin, "我们")).toBe("Wǒmen");
    expect(reading(hanzi, pinyin, "明天")).toBe("míngtiān");
    expect(reading(hanzi, pinyin, "家")).toBe("jiā");
  });

  it("keeps an erhua r with 儿", () => {
    const hanzi = "你去哪儿？";
    const pinyin = "nǐ qù nǎr?";
    expect(reading(hanzi, pinyin, "哪儿")).toBe("nǎr");
    expect(reading(hanzi, pinyin, "儿")).toBe("r");
    expect(reading("她阅读一会儿。", "tā yuèdú yīhuìr.", "一会儿")).toBe("yīhuìr");
  });

  it("keeps the apostrophe in 份额", () => {
    expect(reading("份额", "fèn'é", "份额")).toBe("fèn'é");
  });

  it("keeps nüe as one syllable", () => {
    expect(reading("虐", "nüè", "虐")).toBe("nüè");
  });

  it("splits a vowel-initial syllable written against the previous word", () => {
    expect(reading("这只猫很可爱。", "Zhè zhī māo hěn kěài.", "可爱")).toBe("kěài");
    expect(reading("你的答案不对。", "Nǐ de dáàn bùduì。", "答案")).toBe("dáàn");
    expect(reading("我女儿在上学。", "Wǒ nǚér zài shàngxué.", "女儿")).toBe("nǚér");
    expect(reading("第十二。", "dì shíèr.", "十二")).toBe("shíèr");
  });

  it("keeps a leftover letter on the syllable when it is not itself a syllable", () => {
    expect(reading("她咳了。", "Tā kéi le.", "咳")).toBe("kéi");
  });

  it("splits erhua r after n, including a spaced r", () => {
    expect(reading("我出来玩儿。", "wǒ chūlái wánr.", "玩儿")).toBe("wánr");
    expect(reading("有点儿。", "yǒudiǎnr.", "有点儿")).toBe("yǒudiǎnr");
    expect(reading("早点儿来。", "zǎodiǎn r lái.", "点儿")).toBe("diǎn r");
  });

  it("keeps èr as one syllable", () => {
    expect(reading("二", "èr", "二")).toBe("èr");
    expect(reading("儿子", "érzi", "儿")).toBe("ér");
  });

  it("lines a digit up with a digit and leaves the words around it", () => {
    const hanzi = "早上5点。";
    const pinyin = "zǎoshang 5 diǎn.";
    expect(reading(hanzi, pinyin, "早上")).toBe("zǎoshang");
    expect(reading(hanzi, pinyin, "点")).toBe("diǎn");
  });

  it("returns null when one digit stands for several syllables", () => {
    expect(
      alignSentencePinyin("掌握了20个汉字。", "zhǎngwò le èrshí ge Hànzì."),
    ).toBeNull();
  });

  it("gives each copy of a character its own reading", () => {
    const hanzi = "行行";
    const pinyin = "háng xíng";
    const spans = alignSentencePinyin(hanzi, pinyin);
    expect(spans).not.toBeNull();
    expect(pinyinSlice(pinyin, spans!, 0, 1)).toBe("háng");
    expect(pinyinSlice(pinyin, spans!, 1, 2)).toBe("xíng");
  });
});

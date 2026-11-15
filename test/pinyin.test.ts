import { describe, expect, it } from "vitest";
import { applyToneDigit, PINYIN_SYLLABLES, type PinyinEdit } from "../src/pinyin";

function typePinyin(input: string): string {
  let text = "";
  let caret = 0;
  for (const char of input) {
    const tone = /^[1-5]$/.test(char)
      ? applyToneDigit(text, caret, Number(char))
      : null;
    if (tone) {
      text = text.slice(0, tone.start) + tone.replacement + text.slice(tone.end);
      caret = tone.cursor;
    } else {
      text = text.slice(0, caret) + char + text.slice(caret);
      caret += 1;
    }
  }
  return text;
}

function withoutTones(text: string): string {
  const base: Record<string, string> = {
    ā: "a",
    á: "a",
    ǎ: "a",
    à: "a",
    ē: "e",
    é: "e",
    ě: "e",
    è: "e",
    ī: "i",
    í: "i",
    ǐ: "i",
    ì: "i",
    ō: "o",
    ó: "o",
    ǒ: "o",
    ò: "o",
    ū: "u",
    ú: "u",
    ǔ: "u",
    ù: "u",
    ǖ: "ü",
    ǘ: "ü",
    ǚ: "ü",
    ǜ: "ü",
  };
  return [...text].map((char) => base[char.toLowerCase()] ?? char).join("");
}

function edit(text: string, digit: number, cursor = text.length): PinyinEdit | null {
  return applyToneDigit(text, cursor, digit);
}

describe("pinyin tones", () => {
  it("lists each syllable once", () => {
    expect(new Set(PINYIN_SYLLABLES).size).toBe(PINYIN_SYLLABLES.length);
  });

  it("places a tone on every listed syllable", () => {
    for (const syllable of PINYIN_SYLLABLES) {
      const typed = syllable.replaceAll("ü", "v");
      const result = typePinyin(`${typed}1`);
      expect(result, syllable).not.toBe(`${typed}1`);
      expect(withoutTones(result), syllable).toBe(syllable);
    }
  });

  it("marks the conventional vowel", () => {
    expect(typePinyin("ma1")).toBe("mā");
    expect(typePinyin("xue2")).toBe("xué");
    expect(typePinyin("ni3")).toBe("nǐ");
    expect(typePinyin("hao3")).toBe("hǎo");
    expect(typePinyin("shi4")).toBe("shì");
    expect(typePinyin("gou3")).toBe("gǒu");
    expect(typePinyin("dou1")).toBe("dōu");
    expect(typePinyin("liu2")).toBe("liú");
    expect(typePinyin("gui4")).toBe("guì");
    expect(typePinyin("sheng1")).toBe("shēng");
    expect(typePinyin("lai2")).toBe("lái");
  });

  it("tones syllables from the left, then replaces the last one", () => {
    expect(typePinyin("ni3hao3")).toBe("nǐhǎo");
    expect(typePinyin("nihao33")).toBe("nǐhǎo");
    expect(typePinyin("xuesheng21")).toBe("xuéshēng");
    expect(typePinyin("xue2sheng1")).toBe("xuéshēng");
    expect(typePinyin("zhongguo12")).toBe("zhōngguó");
    expect(typePinyin("zhongguo14")).toBe("zhōngguò");
    expect(typePinyin("ni3hao31")).toBe("nǐhāo");
    expect(typePinyin("ni3hao312")).toBe("nǐháo");
  });

  it("lets 5 remove the last tone mark", () => {
    expect(typePinyin("ni3hao35")).toBe("nǐhao");
    expect(typePinyin("ni3hao355")).toBe("nihao");
    expect(typePinyin("ma5")).toBe("ma");
    expect(edit("nǐhǎo", 5)?.replacement).toBe("nǐhao");
  });

  it("accepts v and ue as ü", () => {
    expect(typePinyin("lv4")).toBe("lǜ");
    expect(typePinyin("nv3")).toBe("nǚ");
    expect(typePinyin("lve4")).toBe("lüè");
    expect(typePinyin("lue4")).toBe("lüè");
    expect(typePinyin("nver32")).toBe("nǚér");
    expect(typePinyin("nuer32")).toBe("nǚér");
    expect(typePinyin("Lv4")).toBe("Lǜ");
    expect(typePinyin("NI3")).toBe("NǏ");
  });

  it("keeps a digit that is not part of a pinyin run", () => {
    expect(typePinyin("hello1")).toBe("hello1");
    expect(typePinyin("very1")).toBe("very1");
    expect(typePinyin("the1")).toBe("the1");
    expect(typePinyin("lesson1")).toBe("lesson1");
    expect(typePinyin("blue4")).toBe("blue4");
    expect(typePinyin("have3")).toBe("have3");
    expect(typePinyin("ok1")).toBe("ok1");
    expect(typePinyin("to1")).toBe("to1");
    expect(typePinyin("I know 3")).toBe("I know 3");
    expect(typePinyin("ni hao3")).toBe("ni hǎo");
    expect(edit("say nihao", 3, 6)?.replacement).toBe("nǐ");
  });

  it("leaves the digit alone when nothing before the cursor is pinyin", () => {
    expect(edit("nihao", 3, 0)).toBeNull();
    expect(edit("nihao", 0, 2)).toBeNull();
    expect(edit("nihao", 6, 2)).toBeNull();
  });

  it("matches the helper the composer loads", async () => {
    const href = new URL("../public/pinyin.js", import.meta.url).href;
    const shipped = ((await import(href)) as { applyToneDigit: typeof applyToneDigit })
      .applyToneDigit;
    for (const syllable of PINYIN_SYLLABLES) {
      const typed = syllable.replaceAll("ü", "v");
      expect(shipped(typed, typed.length, 1), syllable).toEqual(
        applyToneDigit(typed, typed.length, 1),
      );
    }
    expect(shipped("nǐhǎo", 5, 5)).toEqual(applyToneDigit("nǐhǎo", 5, 5));
    expect(shipped("hello", 5, 1)).toBeNull();
  });
});

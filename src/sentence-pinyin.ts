import { suppliedPinyinUnits } from "./pinyin";

/** One character, or one digit run, lined up with a slice of the sentence pinyin. */
export type SentenceSpan = {
  start: number;
  end: number;
  pyStart: number;
  pyEnd: number;
};

const HANZI = /[\u4e00-\u9fff]/u;

function isDigit(char: string): boolean {
  return char >= "0" && char <= "9";
}

function hanziUnits(hanzi: string): { start: number; end: number }[] {
  const units: { start: number; end: number }[] = [];
  let i = 0;
  while (i < hanzi.length) {
    const char = hanzi[i] ?? "";
    if (isDigit(char)) {
      const start = i;
      i += 1;
      while (i < hanzi.length && isDigit(hanzi[i] ?? "")) i += 1;
      units.push({ start, end: i });
      continue;
    }
    if (HANZI.test(char)) {
      units.push({ start: i, end: i + 1 });
      i += 1;
      continue;
    }
    i += 1;
  }
  return units;
}

/**
 * Line a sentence file's pinyin up with its characters.
 * Null when the two sides do not have the same number of units.
 * Callers must not replace a failed line-up with a dictionary reading.
 */
export function alignSentencePinyin(
  hanzi: string,
  pinyin: string,
): SentenceSpan[] | null {
  const syllables = suppliedPinyinUnits(pinyin);
  const characters = hanziUnits(hanzi);
  if (!syllables || syllables.length !== characters.length) return null;
  return characters.map((character, index) => {
    const syllable = syllables[index];
    return {
      start: character.start,
      end: character.end,
      pyStart: syllable?.start ?? 0,
      pyEnd: syllable?.end ?? 0,
    };
  });
}

/** The file's pinyin for hanzi[start, end), including spaces and apostrophes inside it. */
export function pinyinSlice(
  pinyin: string,
  spans: readonly SentenceSpan[],
  start: number,
  end: number,
): string | null {
  let from = -1;
  let to = -1;
  let covered = 0;
  for (const span of spans) {
    if (span.end <= start || span.start >= end) continue;
    if (span.start < start || span.end > end) return null;
    if (from < 0) from = span.pyStart;
    to = span.pyEnd;
    covered += span.end - span.start;
  }
  if (from < 0 || covered !== end - start) return null;
  return pinyin.slice(from, to);
}

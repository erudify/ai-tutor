import { Segmenter } from "./segment";

/** Particles that are not curriculum items. A sentence may keep them. */
const GLUE = new Set("的了着过得地吗呢吧啊呀哦嗯".split(""));

export type ExampleCandidate = {
  hanzi: string;
  pinyin: string;
  english: string;
  tokens: readonly string[] | null;
};

export type Placement = {
  hanzi: string;
  ord: number;
  exampleHanzi: string;
  examplePinyin: string;
  exampleEnglish: string;
};

export type IndexedExample = {
  hanzi: string;
  pinyin: string;
  english: string;
  tokens: string[];
};

/**
 * Words in a sentence, in order.
 * Null when the sentence uses a word that is not in the segmenter and is not glue.
 */
export function curriculumTokens(segmenter: Segmenter, text: string): string[] | null {
  const tokens: string[] = [];
  for (const part of segmenter.segment(text)) {
    if (part.kind === "other") continue;
    if (part.kind === "unknown") {
      if ([...part.hanzi].every((char) => GLUE.has(char))) continue;
      return null;
    }
    tokens.push(part.hanzi);
  }
  return tokens.length > 0 ? tokens : null;
}

function uniqueInOrder(tokens: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const token of tokens) {
    if (seen.has(token)) continue;
    seen.add(token);
    unique.push(token);
  }
  return unique;
}

function charactersOf(tokens: readonly string[]): string[] {
  const chars: string[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    for (const char of token) {
      if (seen.has(char)) continue;
      seen.add(char);
      chars.push(char);
    }
  }
  return chars;
}

/**
 * Build a flat curriculum by ordering sentences.
 * Frequency is the number of these sentences that contain the word.
 * A new word is a token that is not in the curriculum yet.
 * A new character is a character that is not part of a word already in the curriculum.
 * The next sentence contains a new word of the highest frequency. Its rarest
 * new word is as common as possible, then it adds as few new characters as
 * possible, then as few new words as possible. A tie keeps the earlier
 * sentence text (`localeCompare` with `"zh"`). The order of
 * `sentences` is not used. New words from that sentence join with the most
 * frequent first, and that sentence is each new word's example.
 */
export function orderSentences(sentences: readonly ExampleCandidate[]): Placement[] {
  type Parsed = ExampleCandidate & { unique: string[]; chars: string[] };
  const byText = new Map<string, Parsed>();
  for (const sentence of sentences) {
    if (!sentence.tokens || sentence.tokens.length === 0) continue;
    const existing = byText.get(sentence.hanzi);
    if (existing) {
      const pinyin = sentence.pinyin.localeCompare(existing.pinyin, "zh");
      if (
        pinyin < 0 ||
        (pinyin === 0 && sentence.english.localeCompare(existing.english, "zh") < 0)
      ) {
        existing.pinyin = sentence.pinyin;
        existing.english = sentence.english;
      }
      continue;
    }
    const unique = uniqueInOrder(sentence.tokens);
    byText.set(sentence.hanzi, { ...sentence, unique, chars: charactersOf(unique) });
  }

  const pool = [...byText.values()];
  const frequency = new Map<string, number>();
  const byToken = new Map<string, Parsed[]>();
  for (const sentence of pool) {
    for (const token of sentence.unique) {
      frequency.set(token, (frequency.get(token) ?? 0) + 1);
      const list = byToken.get(token) ?? [];
      list.push(sentence);
      byToken.set(token, list);
    }
  }
  const ranked = [...frequency.keys()].sort(
    (left, right) =>
      (frequency.get(right) ?? 0) - (frequency.get(left) ?? 0) ||
      left.localeCompare(right, "zh"),
  );

  const introduced = new Set<string>();
  const knownChars = new Set<string>();
  const placements: Placement[] = [];
  let ord = 0;
  let cursor = 0;
  while (cursor < ranked.length) {
    while (cursor < ranked.length && introduced.has(ranked[cursor] ?? "")) cursor += 1;
    if (cursor >= ranked.length) break;
    const targetFreq = frequency.get(ranked[cursor] ?? "") ?? 0;
    let bandEnd = cursor + 1;
    while (bandEnd < ranked.length && frequency.get(ranked[bandEnd] ?? "") === targetFreq) {
      bandEnd += 1;
    }

    let best: Parsed | null = null;
    let bestChars = Infinity;
    let bestWords = Infinity;
    let bestMinFreq = -1;
    const seenSentence = new Set<Parsed>();
    for (let index = cursor; index < bandEnd; index += 1) {
      const word = ranked[index];
      if (!word || introduced.has(word)) continue;
      for (const sentence of byToken.get(word) ?? []) {
        if (seenSentence.has(sentence)) continue;
        seenSentence.add(sentence);
        let newWords = 0;
        let minFreq = Infinity;
        for (const token of sentence.unique) {
          if (introduced.has(token)) continue;
          newWords += 1;
          const wordFreq = frequency.get(token) ?? 0;
          if (wordFreq < minFreq) minFreq = wordFreq;
        }
        if (newWords === 0) continue;
        let newChars = 0;
        for (const char of sentence.chars) if (!knownChars.has(char)) newChars += 1;
        const textBetter =
          best !== null &&
          minFreq === bestMinFreq &&
          newChars === bestChars &&
          newWords === bestWords &&
          sentence.hanzi.localeCompare(best.hanzi, "zh") < 0;
        const better =
          best === null ||
          minFreq > bestMinFreq ||
          (minFreq === bestMinFreq && newChars < bestChars) ||
          (minFreq === bestMinFreq && newChars === bestChars && newWords < bestWords) ||
          textBetter;
        if (better) {
          best = sentence;
          bestChars = newChars;
          bestWords = newWords;
          bestMinFreq = minFreq;
        }
      }
    }
    if (!best) {
      cursor = bandEnd;
      continue;
    }

    const added = best.unique.filter((token) => !introduced.has(token));
    added.sort((left, right) => (frequency.get(right) ?? 0) - (frequency.get(left) ?? 0));
    for (const token of added) {
      placements.push({
        hanzi: token,
        ord,
        exampleHanzi: best.hanzi,
        examplePinyin: best.pinyin,
        exampleEnglish: best.english,
      });
      introduced.add(token);
      for (const char of token) knownChars.add(char);
      ord += 1;
    }
  }
  return placements;
}

/**
 * A legal example uses this word and words introduced in its sentence or
 * earlier (`ord <= limit`). Fewer unknown words win. Once the student knows
 * those words, a longer sentence wins. A tie keeps the earlier sentence text.
 */
export function pickExample(
  sentences: readonly IndexedExample[],
  wordHanzi: string,
  limit: number | null,
  ordOf: (hanzi: string) => number | null,
  known: ReadonlySet<string>,
): IndexedExample | null {
  let best: IndexedExample | null = null;
  let bestUnknown = Infinity;
  let bestComplexity = 0;
  for (const sentence of sentences) {
    const unique: string[] = [];
    const seen = new Set<string>();
    let unknown = 0;
    let legal = true;
    for (const token of sentence.tokens) {
      if (seen.has(token)) continue;
      seen.add(token);
      unique.push(token);
      if (token === wordHanzi) continue;
      const ord = ordOf(token);
      if (limit === null) {
        if (!known.has(token)) {
          legal = false;
          break;
        }
        continue;
      }
      if (ord === null || ord > limit) {
        legal = false;
        break;
      }
      if (!known.has(token)) unknown += 1;
    }
    if (!legal || !seen.has(wordHanzi)) continue;
    const complexity = unique.length;
    let better = best === null || unknown < bestUnknown;
    if (!better && best !== null && unknown === bestUnknown) {
      const longerKnown = unknown === 0;
      const complexityBetter = longerKnown
        ? complexity > bestComplexity
        : complexity < bestComplexity;
      const lengthBetter =
        complexity === bestComplexity &&
        (longerKnown
          ? sentence.hanzi.length > best.hanzi.length
          : sentence.hanzi.length < best.hanzi.length);
      const textBetter =
        complexity === bestComplexity &&
        sentence.hanzi.length === best.hanzi.length &&
        sentence.hanzi.localeCompare(best.hanzi, "zh") < 0;
      better = complexityBetter || lengthBetter || textBetter;
    }
    if (better) {
      best = sentence;
      bestUnknown = unknown;
      bestComplexity = complexity;
    }
  }
  return best;
}

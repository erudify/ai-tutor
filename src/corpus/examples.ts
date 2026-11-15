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

/**
 * Build a flat curriculum by ordering sentences.
 * The next sentence is the one that introduces the earliest remaining lesson
 * word. It adds as few words from outside the lessons as possible, then as
 * few new words as possible. Words join in left-to-right first appearance,
 * and that sentence is each new word's example.
 */
export function orderSentences(
  sentences: readonly ExampleCandidate[],
  sourceOrd: ReadonlyMap<string, number> = new Map(),
): Placement[] {
  type Parsed = ExampleCandidate & { unique: string[]; position: number };
  const pool: Parsed[] = [];
  const seenText = new Set<string>();
  for (const sentence of sentences) {
    if (!sentence.tokens || sentence.tokens.length === 0) continue;
    if (seenText.has(sentence.hanzi)) continue;
    seenText.add(sentence.hanzi);
    pool.push({ ...sentence, unique: uniqueInOrder(sentence.tokens), position: pool.length });
  }
  const byToken = new Map<string, Parsed[]>();
  for (const sentence of pool) {
    for (const token of sentence.unique) {
      const list = byToken.get(token) ?? [];
      list.push(sentence);
      byToken.set(token, list);
    }
  }

  const introduced = new Set<string>();
  const placements: Placement[] = [];
  let ord = 0;
  const rank = (hanzi: string) => sourceOrd.get(hanzi) ?? Number.MAX_SAFE_INTEGER;
  const targets = [...sourceOrd.entries()].sort((left, right) => left[1] - right[1]);
  for (const [target] of targets) {
    if (introduced.has(target)) continue;
    const options = byToken.get(target);
    if (!options) continue;
    let best: Parsed | null = null;
    let bestExtras = Infinity;
    let bestNews = Infinity;
    let bestRank = Infinity;
    for (const sentence of options) {
      let news = 0;
      let extras = 0;
      let far = 0;
      for (const token of sentence.unique) {
        if (introduced.has(token)) continue;
        news += 1;
        const tokenRank = rank(token);
        if (tokenRank === Number.MAX_SAFE_INTEGER) extras += 1;
        else if (tokenRank > far) far = tokenRank;
      }
      if (news === 0) continue;
      const better =
        extras < bestExtras ||
        (extras === bestExtras && news < bestNews) ||
        (extras === bestExtras && news === bestNews && far < bestRank) ||
        (extras === bestExtras &&
          news === bestNews &&
          far === bestRank &&
          best !== null &&
          (sentence.unique.length < best.unique.length ||
            (sentence.unique.length === best.unique.length &&
              sentence.position < best.position)));
      if (best === null || better) {
        best = sentence;
        bestExtras = extras;
        bestNews = news;
        bestRank = far;
      }
    }
    if (!best) continue;
    for (const token of best.unique) {
      if (introduced.has(token)) continue;
      placements.push({
        hanzi: token,
        ord,
        exampleHanzi: best.hanzi,
        examplePinyin: best.pinyin,
        exampleEnglish: best.english,
      });
      introduced.add(token);
      ord += 1;
    }
  }
  return placements;
}

/**
 * A legal example uses this word and words introduced in its sentence or
 * earlier (`ord <= limit`). Fewer unknown words win. Once the student knows
 * those words, a longer sentence wins.
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
    const richer =
      unknown === 0 && bestUnknown === 0
        ? complexity > bestComplexity ||
          (complexity === bestComplexity &&
            best !== null &&
            sentence.hanzi.length > best.hanzi.length)
        : complexity < bestComplexity ||
          (complexity === bestComplexity &&
            best !== null &&
            sentence.hanzi.length < best.hanzi.length);
    if (best === null || unknown < bestUnknown || (unknown === bestUnknown && richer)) {
      best = sentence;
      bestUnknown = unknown;
      bestComplexity = complexity;
    }
  }
  return best;
}

import { hanziOnly, type RawSentence } from "./parse";

const FUNCTION = new Set("的了是我你他她它在有和也很都吗呢吧不没人个这那一".split(""));

export type Cluster = {
  word: string | null;
  sentences: RawSentence[];
};

function allFunction(word: string): boolean {
  return [...word].every((char) => FUNCTION.has(char));
}

function candidatesOf(text: string): string[] {
  const chars = hanziOnly(text);
  const found = new Set<string>();
  for (let i = 0; i < chars.length; i += 1) {
    const max = Math.min(4, chars.length - i);
    for (let len = 1; len <= max; len += 1) {
      const word = chars.slice(i, i + len);
      found.add(word);
      const trimmed = word.replace(/^[的地得]+/u, "").replace(/[的地得]+$/u, "");
      if (trimmed && trimmed.length <= 4) found.add(trimmed);
    }
  }
  return [...found];
}

function bestShared(window: RawSentence[]): string | null {
  const lists = window.map((sentence) => candidatesOf(sentence.hanzi));
  const [first, ...rest] = lists;
  if (!first) return null;
  let best: string | null = null;
  let bestScore = -Infinity;
  for (const word of first) {
    if (!rest.every((list) => list.includes(word))) continue;
    let score = word.length * 10;
    if (word.length === 2 || word.length === 3) score += 8;
    if (word.length === 4) score += 2;
    if (word.length === 1) score -= 6;
    if (allFunction(word)) score -= 25;
    if (/^[的地得]/u.test(word) && word.length > 1) score -= 30;
    if (/[的地得]$/u.test(word) && word.length > 1) score -= 12;
    if (score > bestScore) {
      bestScore = score;
      best = word;
    }
  }
  return best;
}

const LENGTHS = [5, 10, 4, 6, 9, 8, 3, 7, 11, 2];

function segmentCost(
  sentences: RawSentence[],
  start: number,
  length: number,
): { cost: number; word: string } | null {
  if (start + length > sentences.length) return null;
  const window = sentences.slice(start, start + length);
  const word = bestShared(window);
  if (!word) return null;
  let cost = 0;
  if (length === 5 || length === 10) cost += 0;
  else if (length === 4 || length === 6 || length === 8 || length === 9) cost += 4;
  else cost += 9;
  if (word.length >= 4) cost += 2;
  if (word.length === 1) cost += 3;
  if (allFunction(word)) cost += 6;
  if (/^[的地得]/u.test(word) && word.length > 1) cost += 8;
  const previous = sentences[start - 1];
  const next = sentences[start + length];
  if (previous?.hanzi.includes(word)) cost += 3;
  if (next?.hanzi.includes(word)) cost += 3;
  cost -= Math.min(word.length, 3);
  return { cost, word };
}

/**
 * The sentence files are runs of examples for one target, usually 5 or 10
 * long, with no headword label. Dynamic programming picks those runs.
 * A run with no shared word becomes a one-sentence orphan (`word: null`).
 */
export function clusterSentences(sentences: RawSentence[]): Cluster[] {
  const count = sentences.length;
  const cost = new Float64Array(count + 1).fill(1e12);
  const previous = new Int32Array(count + 1).fill(-1);
  const wordAt: (string | null)[] = new Array(count + 1).fill(null);
  cost[0] = 0;
  for (let i = 0; i < count; i += 1) {
    if (cost[i] > 1e11) continue;
    const orphan = cost[i] + 14;
    if (orphan < cost[i + 1]) {
      cost[i + 1] = orphan;
      previous[i + 1] = i;
      wordAt[i + 1] = null;
    }
    for (const length of LENGTHS) {
      const scored = segmentCost(sentences, i, length);
      if (!scored) continue;
      const nextCost = cost[i] + scored.cost;
      if (nextCost < cost[i + length]) {
        cost[i + length] = nextCost;
        previous[i + length] = i;
        wordAt[i + length] = scored.word;
      }
    }
  }
  const groups: Cluster[] = [];
  let end = count;
  while (end > 0) {
    const start = previous[end];
    if (start < 0) break;
    groups.push({
      word: wordAt[end],
      sentences: sentences.slice(start, end),
    });
    end = start;
  }
  groups.reverse();
  return groups;
}

/**
 * One example in a run often uses a longer dictionary word (考虑) while a
 * neighbour only shares a character (熟虑). Prefer the longer dictionary
 * word when it still covers most of the run.
 */
export function upgradeHeadword(
  word: string,
  sentences: readonly string[],
  dictionary: ReadonlySet<string>,
): string {
  const options = new Set<string>([word]);
  for (const sentence of sentences) {
    const chars = hanziOnly(sentence);
    let from = 0;
    while (from < chars.length) {
      const at = chars.indexOf(word, from);
      if (at < 0) break;
      for (const extra of [1, 2, 3]) {
        if (at >= extra) options.add(chars.slice(at - extra, at + word.length));
        if (at + word.length + extra <= chars.length) {
          options.add(chars.slice(at, at + word.length + extra));
        }
      }
      from = at + 1;
    }
  }
  let best = word;
  let bestCoverage = sentences.length;
  const needed = Math.ceil(sentences.length * 0.6);
  for (const option of options) {
    if (option !== word && !dictionary.has(option)) continue;
    if (option.length > 8) continue;
    const coverage =
      option === word
        ? sentences.length
        : sentences.filter((sentence) => sentence.includes(option)).length;
    if (coverage < needed) continue;
    if (option.length > best.length || (option.length === best.length && coverage > bestCoverage)) {
      best = option;
      bestCoverage = coverage;
    }
  }
  return best;
}

import { clusterSentences, upgradeHeadword } from "./cluster";
import { parseCedict } from "./cedict";
import { curriculumTokens, orderSentences } from "./examples";
import { hanziOnly, parseSentenceFile, type RawSentence } from "./parse";
import { Segmenter } from "./segment";

export type BuiltWord = {
  hanzi: string;
  pinyin: string;
  gloss: string;
  level: number | null;
  ord: number | null;
  curriculum: boolean;
  exampleHanzi: string;
  examplePinyin: string;
  exampleEnglish: string;
};

export type BuiltSentence = {
  id: string;
  headword: string;
  hanzi: string;
  pinyin: string;
  english: string;
  position: number;
};

export type BuiltCorpus = {
  words: BuiltWord[];
  sentences: BuiltSentence[];
};

export type LevelFile = {
  level: number;
  text: string;
};

type Lesson = {
  level: number;
  ord: number;
  sentences: RawSentence[];
};

type TrieNode = {
  children: Map<string, TrieNode>;
  word: string | null;
};

function firstExamples(
  sentences: readonly RawSentence[],
  wanted: ReadonlySet<string>,
): Map<string, RawSentence> {
  const root: TrieNode = { children: new Map(), word: null };
  for (const word of wanted) {
    let node = root;
    for (const char of word) {
      let child = node.children.get(char);
      if (!child) {
        child = { children: new Map(), word: null };
        node.children.set(char, child);
      }
      node = child;
    }
    node.word = word;
  }
  const found = new Map<string, RawSentence>();
  for (const sentence of sentences) {
    if (found.size === wanted.size) break;
    const chars = hanziOnly(sentence.hanzi);
    for (let i = 0; i < chars.length; i += 1) {
      let node = root;
      for (let j = i; j < chars.length; j += 1) {
        const child = node.children.get(chars[j]);
        if (!child) break;
        node = child;
        if (node.word && !found.has(node.word)) found.set(node.word, sentence);
      }
    }
  }
  return found;
}

function substrings(text: string): Set<string> {
  const chars = hanziOnly(text);
  const found = new Set<string>();
  for (let i = 0; i < chars.length; i += 1) {
    const max = Math.min(8, chars.length - i);
    for (let len = 1; len <= max; len += 1) found.add(chars.slice(i, i + len));
  }
  return found;
}

/**
 * Curriculum order is a flat list made by ordering the sentences. Each
 * sentence introduces the earliest remaining lesson word and adds as few
 * other words as possible. CC-CEDICT supplies spellings, pinyin, and glosses.
 * A word the clusters never teach on purpose, such as 喜欢, joins the list
 * when a sentence needs it.
 */
export function buildCorpus(levels: readonly LevelFile[], cedictText: string): BuiltCorpus {
  const dictionary = parseCedict(cedictText);
  const dictionaryWords = new Set(dictionary.keys());
  const lessons = new Map<string, Lesson>();
  const allSentences: RawSentence[] = [];
  let ord = 0;

  for (const file of levels) {
    const parsed = parseSentenceFile(file.text);
    allSentences.push(...parsed);
    for (const group of clusterSentences(parsed)) {
      if (!group.word) continue;
      const texts = group.sentences.map((sentence) => sentence.hanzi);
      const head = upgradeHeadword(group.word, texts, dictionaryWords);
      const existing = lessons.get(head);
      if (existing) {
        existing.sentences.push(...group.sentences);
      } else {
        lessons.set(head, { level: file.level, ord, sentences: [...group.sentences] });
        ord += 1;
      }
    }
  }

  const seen = new Set<string>();
  for (const sentence of allSentences) {
    for (const piece of substrings(sentence.hanzi)) seen.add(piece);
  }

  const present = new Map<string, { pinyin: string; gloss: string }>();
  for (const [hanzi, entry] of dictionary) {
    if (seen.has(hanzi)) present.set(hanzi, entry);
  }
  for (const hanzi of lessons.keys()) {
    if (!present.has(hanzi)) present.set(hanzi, { pinyin: "", gloss: "" });
  }

  const firstUse = firstExamples(allSentences, new Set(present.keys()));
  const lexiconSegmenter = new Segmenter([...present.keys()]);
  const placement = new Map(
    orderSentences(
      allSentences.map((sentence) => ({
        hanzi: sentence.hanzi,
        pinyin: sentence.pinyin,
        english: sentence.english,
        tokens: curriculumTokens(lexiconSegmenter, sentence.hanzi),
      })),
      new Map([...lessons.entries()].map(([hanzi, lesson]) => [hanzi, lesson.ord])),
    ).map((item) => [item.hanzi, item]),
  );
  const curriculumSegmenter = new Segmenter([...placement.keys()]);

  const words: BuiltWord[] = [];
  for (const [hanzi, entry] of present) {
    const lesson = lessons.get(hanzi);
    const placed = placement.get(hanzi);
    const example = lesson?.sentences[0] ?? firstUse.get(hanzi);
    if (!placed && !example) continue;
    const gloss = entry.gloss || placed?.exampleEnglish || example?.english || "";
    words.push({
      hanzi,
      pinyin: entry.pinyin,
      gloss,
      level: lesson?.level ?? null,
      ord: placed?.ord ?? null,
      curriculum: placed !== undefined,
      exampleHanzi: placed?.exampleHanzi ?? example?.hanzi ?? hanzi,
      examplePinyin: placed?.examplePinyin || entry.pinyin,
      exampleEnglish: placed ? placed.exampleEnglish || gloss : (example?.english ?? gloss),
    });
  }
  words.sort((a, b) => {
    if (a.curriculum !== b.curriculum) return a.curriculum ? -1 : 1;
    if (a.ord !== null && b.ord !== null && a.ord !== b.ord) return a.ord - b.ord;
    return a.hanzi.localeCompare(b.hanzi, "zh");
  });

  const sentences: BuiltSentence[] = [];
  const seenSentence = new Set<string>();
  let position = 0;
  for (const sentence of allSentences) {
    if (seenSentence.has(sentence.hanzi)) continue;
    const tokens = curriculumTokens(curriculumSegmenter, sentence.hanzi);
    if (!tokens) continue;
    seenSentence.add(sentence.hanzi);
    sentences.push({
      id: `s${position}`,
      headword: tokens[0],
      hanzi: sentence.hanzi,
      pinyin: sentence.pinyin,
      english: sentence.english,
      position,
    });
    position += 1;
  }

  return { words, sentences };
}

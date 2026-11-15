import { curriculumTokens, type IndexedExample } from "./examples";
import { Segmenter } from "./segment";
import type { BuiltSentence, BuiltWord } from "./build";

/**
 * Structural chunks that CC-CEDICT lists and students say constantly.
 * They are not review items unless the curriculum teaches them on purpose.
 */
const STRUCTURAL = new Set([
  "一个",
  "这个",
  "那个",
  "这里",
  "那里",
  "哪里",
  "什么",
  "怎么",
  "为什么",
  "我们",
  "你们",
  "他们",
  "她们",
  "它们",
  "一下",
  "的时候",
  "时候",
  "自己的",
  "有的",
]);

const QUESTION_WORDS = new Set(["什么", "怎么", "为什么", "意思", "是", "吗", "呢", "哪"]);

export type Word = {
  hanzi: string;
  pinyin: string;
  gloss: string;
  level: number | null;
  ord: number | null;
  curriculum: boolean;
  tracked: boolean;
  exampleHanzi: string;
  examplePinyin: string;
  exampleEnglish: string;
  /**
   * Highest curriculum ord that may appear in an example for this word.
   * Words introduced by the same sentence share it.
   */
  exampleLimit: number | null;
};

export type ExampleSentence = {
  id: string;
  headword: string;
  hanzi: string;
  pinyin: string;
  english: string;
  position: number;
};

export type Corpus = {
  words: Word[];
  byHanzi: Map<string, Word>;
  curriculum: Word[];
  sentencesByHeadword: Map<string, ExampleSentence[]>;
  /** Legal example sentences that contain each curriculum word. */
  examplesByToken: Map<string, IndexedExample[]>;
  segmenter: Segmenter;
};

export function isQuestionWord(hanzi: string): boolean {
  return QUESTION_WORDS.has(hanzi);
}

export function indexCorpus(builtWords: readonly BuiltWord[], builtSentences: readonly BuiltSentence[]): Corpus {
  const words: Word[] = builtWords.map((word) => ({
    hanzi: word.hanzi,
    pinyin: word.pinyin,
    gloss: word.gloss,
    level: word.level,
    ord: word.ord,
    curriculum: word.curriculum,
    tracked: word.curriculum || (word.hanzi.length >= 2 && !STRUCTURAL.has(word.hanzi)),
    exampleHanzi: word.exampleHanzi,
    examplePinyin: word.examplePinyin,
    exampleEnglish: word.exampleEnglish,
    exampleLimit: null,
  }));
  const byHanzi = new Map(words.map((word) => [word.hanzi, word]));
  const curriculum = words
    .filter((word) => word.curriculum)
    .sort((a, b) => (a.ord ?? 0) - (b.ord ?? 0));
  const limitByExample = new Map<string, number>();
  for (const word of curriculum) {
    if (word.ord === null) continue;
    const prev = limitByExample.get(word.exampleHanzi) ?? -1;
    if (word.ord > prev) limitByExample.set(word.exampleHanzi, word.ord);
  }
  for (const word of curriculum) {
    word.exampleLimit =
      word.ord === null ? null : (limitByExample.get(word.exampleHanzi) ?? word.ord);
  }
  const sentencesByHeadword = new Map<string, ExampleSentence[]>();
  for (const sentence of builtSentences) {
    const list = sentencesByHeadword.get(sentence.headword) ?? [];
    list.push(sentence);
    sentencesByHeadword.set(sentence.headword, list);
  }
  const examplesByToken = indexExamples(
    curriculum.map((word) => word.hanzi),
    builtSentences,
  );
  return {
    words,
    byHanzi,
    curriculum,
    sentencesByHeadword,
    examplesByToken,
    segmenter: new Segmenter(words.map((word) => word.hanzi)),
  };
}

function indexExamples(
  curriculum: readonly string[],
  sentences: readonly BuiltSentence[],
): Map<string, IndexedExample[]> {
  const segmenter = new Segmenter(curriculum);
  const byToken = new Map<string, IndexedExample[]>();
  const seen = new Set<string>();
  for (const sentence of sentences) {
    if (seen.has(sentence.hanzi)) continue;
    const tokens = curriculumTokens(segmenter, sentence.hanzi);
    if (!tokens) continue;
    seen.add(sentence.hanzi);
    const indexed: IndexedExample = {
      hanzi: sentence.hanzi,
      pinyin: sentence.pinyin,
      english: sentence.english,
      tokens,
    };
    for (const token of new Set(tokens)) {
      const list = byToken.get(token) ?? [];
      list.push(indexed);
      byToken.set(token, list);
    }
  }
  return byToken;
}

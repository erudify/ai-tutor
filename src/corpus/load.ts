import { indexCorpus, type Corpus } from "./model";
import type { BuiltSentence, BuiltWord } from "./build";

type WordRow = {
  hanzi: string;
  pinyin: string;
  gloss: string;
  level: number | null;
  ord: number | null;
  curriculum: number;
  example_hanzi: string;
  example_pinyin: string;
  example_english: string;
};

type SentenceRow = {
  id: string;
  hanzi: string;
  pinyin: string;
  english: string;
};

export class CorpusEmptyError extends Error {
  constructor() {
    super("The curriculum database is empty. Run npm run seed.");
  }
}

export async function loadCorpus(db: D1Database): Promise<Corpus> {
  const words = await db
    .prepare(
      `SELECT hanzi, pinyin, gloss, level, ord, curriculum,
              example_hanzi, example_pinyin, example_english
       FROM words`,
    )
    .all<WordRow>();
  const sentences = await db
    .prepare(
      `SELECT id, hanzi, pinyin, english
       FROM sentences`,
    )
    .all<SentenceRow>();
  if (words.results.length === 0) throw new CorpusEmptyError();
  const builtWords: BuiltWord[] = words.results.map((row) => ({
    hanzi: row.hanzi,
    pinyin: row.pinyin,
    gloss: row.gloss,
    level: row.level,
    ord: row.ord,
    curriculum: row.curriculum === 1,
    exampleHanzi: row.example_hanzi,
    examplePinyin: row.example_pinyin,
    exampleEnglish: row.example_english,
  }));
  const builtSentences: BuiltSentence[] = sentences.results.map((row) => ({
    id: row.id,
    hanzi: row.hanzi,
    pinyin: row.pinyin,
    english: row.english,
  }));
  return indexCorpus(builtWords, builtSentences);
}

let cached: Promise<Corpus> | null = null;

export function getCorpus(db: D1Database): Promise<Corpus> {
  if (!cached) {
    cached = loadCorpus(db).catch((error: unknown) => {
      cached = null;
      throw error;
    });
  }
  return cached;
}

CREATE TABLE IF NOT EXISTS words (
  hanzi TEXT PRIMARY KEY,
  pinyin TEXT NOT NULL,
  gloss TEXT NOT NULL,
  level INTEGER,
  ord INTEGER,
  curriculum INTEGER NOT NULL,
  example_hanzi TEXT NOT NULL,
  example_pinyin TEXT NOT NULL,
  example_english TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS words_curriculum ON words (curriculum, ord);

CREATE TABLE IF NOT EXISTS sentences (
  id TEXT PRIMARY KEY,
  headword TEXT NOT NULL,
  hanzi TEXT NOT NULL,
  pinyin TEXT NOT NULL,
  english TEXT NOT NULL,
  position INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS sentences_headword ON sentences (headword, position);

export type RawSentence = {
  hanzi: string;
  pinyin: string;
  english: string;
};

const FIELD = /^(Chinese|Pinyin|English):\s*(.*)$/;

/** Parse one haoxue-public sentence file. Incomplete blocks are dropped. */
export function parseSentenceFile(text: string): RawSentence[] {
  const blocks = text
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);
  const sentences: RawSentence[] = [];
  for (const block of blocks) {
    let hanzi = "";
    let pinyin = "";
    let english = "";
    for (const line of block.split("\n")) {
      const match = FIELD.exec(line.trim());
      if (!match) continue;
      const value = match[2].trim();
      if (match[1] === "Chinese") hanzi = value;
      else if (match[1] === "Pinyin") pinyin = value;
      else english = value;
    }
    if (hanzi && pinyin && english) sentences.push({ hanzi, pinyin, english });
  }
  return sentences;
}

export function hanziOnly(text: string): string {
  return text.replace(/[^\u4e00-\u9fff]/gu, "");
}

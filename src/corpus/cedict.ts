export type DictEntry = {
  pinyin: string;
  gloss: string;
};

const LINE =
  /^(\S+)\s+(\S+)\s+\[([^\]]+)\]\s+\/(.+)\/\s*$/;

const VOWEL_MARKS: Record<string, readonly string[]> = {
  a: ["a", "ā", "á", "ǎ", "à"],
  e: ["e", "ē", "é", "ě", "è"],
  i: ["i", "ī", "í", "ǐ", "ì"],
  o: ["o", "ō", "ó", "ǒ", "ò"],
  u: ["u", "ū", "ú", "ǔ", "ù"],
  ü: ["ü", "ǖ", "ǘ", "ǚ", "ǜ"],
};

function markSyllable(raw: string): string {
  const match = /^([A-Za-züÜ:vV]+)([1-5])$/.exec(raw);
  if (!match) return raw;
  const tone = Number(match[2]);
  const body = match[1].replaceAll("u:", "ü").replaceAll("v", "ü").replaceAll("V", "Ü");
  if (tone === 5) return body;
  const chars = [...body];
  const vowels = chars
    .map((char, index) => ({ char: char.toLowerCase(), index }))
    .filter((item) => "aeiouü".includes(item.char));
  if (vowels.length === 0) return body;
  const a = vowels.find((item) => item.char === "a");
  const e = vowels.find((item) => item.char === "e");
  let target = vowels[vowels.length - 1].index;
  if (a) target = a.index;
  else if (e) target = e.index;
  else if (vowels.some((item) => item.char === "o") && vowels.some((item) => item.char === "u")) {
    const o = vowels.find((item) => item.char === "o");
    if (o) target = o.index;
  } else if (vowels.length >= 2) {
    target = vowels[1].index;
  }
  const current = chars[target];
  const lower = current.toLowerCase();
  const marked = VOWEL_MARKS[lower]?.[tone];
  if (!marked) return body;
  chars[target] = current === lower ? marked : marked.toUpperCase();
  return chars.join("");
}

export function formatPinyin(raw: string): string {
  return raw
    .split(/\s+/)
    .filter((part) => part.length > 0)
    .map((part) => markSyllable(part))
    .join(" ");
}

function cleanGloss(raw: string): string {
  const parts = raw
    .split("/")
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && !part.startsWith("variant of") && !part.startsWith("old variant"));
  let text = parts.slice(0, 2).join("; ");
  if (!text) text = raw.split("/")[0]?.trim() ?? "";
  if (text.length > 140) text = `${text.slice(0, 137)}...`;
  return text;
}

export type Reading = {
  pinyin: string;
  gloss: string;
};

/**
 * Every simplified headword, with each distinct reading.
 * The curriculum parser keeps one reading and drops long headwords.
 */
export function parseLookup(text: string): Map<string, Reading[]> {
  const dictionary = new Map<string, Reading[]>();
  for (const line of text.split("\n")) {
    if (line.startsWith("#") || line.trim().length === 0) continue;
    const match = LINE.exec(line);
    if (!match) continue;
    const simplified = match[2];
    if (!/^[\u4e00-\u9fff]+$/u.test(simplified)) continue;
    const reading = { pinyin: formatPinyin(match[3]), gloss: cleanGloss(match[4]) };
    const readings = dictionary.get(simplified);
    if (!readings) {
      dictionary.set(simplified, [reading]);
      continue;
    }
    if (readings.some((item) => item.pinyin === reading.pinyin)) continue;
    readings.push(reading);
  }
  return dictionary;
}

/** Parse CC-CEDICT. The first simplified entry wins. */
export function parseCedict(text: string): Map<string, DictEntry> {
  const dictionary = new Map<string, DictEntry>();
  for (const line of text.split("\n")) {
    if (line.startsWith("#") || line.trim().length === 0) continue;
    const match = LINE.exec(line);
    if (!match) continue;
    const simplified = match[2];
    if (!/^[\u4e00-\u9fff]{1,8}$/u.test(simplified)) continue;
    if (dictionary.has(simplified)) continue;
    dictionary.set(simplified, {
      pinyin: formatPinyin(match[3]),
      gloss: cleanGloss(match[4]),
    });
  }
  return dictionary;
}

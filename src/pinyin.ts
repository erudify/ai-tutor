/**
 * Tone numbers in the chat box.
 * 1–4 place that tone on the next untone syllable before the cursor.
 * 5 removes the last tone mark in that run (a neutral tone).
 * The run is rewritten only when every syllable is real pinyin, so a digit
 * after an ordinary English word stays a digit.
 * Syllable breaks follow the other Erudify input: nüe is two syllables, lüe is one.
 */

const toneMap: Record<string, readonly string[]> = {
  a: ["a", "ā", "á", "ǎ", "à"],
  e: ["e", "ē", "é", "ě", "è"],
  i: ["i", "ī", "í", "ǐ", "ì"],
  o: ["o", "ō", "ó", "ǒ", "ò"],
  u: ["u", "ū", "ú", "ǔ", "ù"],
  ü: ["ü", "ǖ", "ǘ", "ǚ", "ǜ"],
  v: ["ü", "ǖ", "ǘ", "ǚ", "ǜ"],
};

const tonedVowelMap: Record<string, { base: string; tone: number }> = {};
for (const [base, tones] of Object.entries(toneMap)) {
  for (let tone = 1; tone <= 4; tone += 1) {
    const toned = tones[tone];
    if (toned && toned !== base) {
      tonedVowelMap[toned] = { base: base === "v" ? "ü" : base, tone };
    }
  }
}

/** Standard spellings, including nü / lü and the zero-initial forms (yi, wu, yu). */
export const PINYIN_SYLLABLES: readonly string[] = `
a ai an ang ao e ei en eng er o ou
ba bai ban bang bao bei ben beng bi bian biao bie bin bing bo bu
pa pai pan pang pao pei pen peng pi pian piao pie pin ping po pou pu
ma mai man mang mao me mei men meng mi mian miao mie min ming miu mo mou mu
fa fan fang fei fen feng fo fou fu
da dai dan dang dao de dei deng di dia dian diao die ding diu dong dou du duan dui dun duo
ta tai tan tang tao te teng ti tian tiao tie ting tong tou tu tuan tui tun tuo
na nai nan nang nao ne nei nen neng ni nian niang niao nie nin ning niu nong nou nu nuan nuo nü
la lai lan lang lao le lei leng li lia lian liang liao lie lin ling liu lo long lou lu luan lun luo lü lüe
ga gai gan gang gao ge gei gen geng gong gou gu gua guai guan guang gui gun guo
ka kai kan kang kao ke ken keng kong kou ku kua kuai kuan kuang kui kun kuo
ha hai han hang hao he hei hen heng hong hou hu hua huai huan huang hui hun huo
za zai zan zang zao ze zei zen zeng zi zong zou zu zuan zui zun zuo
ca cai can cang cao ce cen ceng ci cong cou cu cuan cui cun cuo
sa sai san sang sao se sen seng si song sou su suan sui sun suo
zha zhai zhan zhang zhao zhe zhei zhen zheng zhi zhong zhou zhu zhua zhuai zhuan zhuang zhui zhun zhuo
cha chai chan chang chao che chen cheng chi chong chou chu chua chuai chuan chuang chui chun chuo
sha shai shan shang shao she shei shen sheng shi shou shu shua shuai shuan shuang shui shun shuo
re ren reng ri rong rou ru ruan rui run ruo
ji jia jian jiang jiao jie jin jing jiong jiu ju juan jue jun
qi qia qian qiang qiao qie qin qing qiong qiu qu quan que qun
xi xia xian xiang xiao xie xin xing xiong xiu xu xuan xue xun
yi ya yan yang yao ye yin ying yo yong you yu yuan yue yun
wu wa wai wan wang wei wen weng wo
`
  .trim()
  .split(/\s+/);

const legalSyllables = new Set(PINYIN_SYLLABLES);

/**
 * Sentence files write nüe as one syllable (虐).
 * The composer still splits a typed nue into nü + e.
 */
const sentenceSyllables = new Set<string>(PINYIN_SYLLABLES);
sentenceSyllables.add("nüe");
const sentencePrefixes = new Set<string>();
for (const syllable of sentenceSyllables) {
  for (let length = 1; length <= syllable.length; length += 1) {
    sentencePrefixes.add(syllable.slice(0, length));
  }
}

export type PinyinEdit = {
  start: number;
  end: number;
  replacement: string;
  cursor: number;
};

function getBaseVowel(char: string): string {
  const lower = char.toLowerCase();
  const info = tonedVowelMap[lower];
  if (info) return info.base;
  if (lower === "v") return "ü";
  if (toneMap[lower]) return lower;
  return lower;
}

function isVowel(char: string): boolean {
  const lower = char.toLowerCase();
  return lower in toneMap || lower in tonedVowelMap;
}

function isPinyinChar(char: string): boolean {
  return /[a-züāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]/.test(char.toLowerCase());
}

function isTonedVowel(char: string): boolean {
  return char.toLowerCase() in tonedVowelMap;
}

function findToneVowelIndex(syllable: string): number {
  let lastVowel = -1;
  let hasA = -1;
  let hasE = -1;
  let hasOu = false;
  let oIndex = -1;
  const chars = [...syllable];
  for (let i = 0; i < chars.length; i += 1) {
    const char = chars[i];
    if (!char || !isVowel(char)) continue;
    const base = getBaseVowel(char);
    lastVowel = i;
    if (base === "a") hasA = i;
    if (base === "e") hasE = i;
    if (base === "o") oIndex = i;
    if (base === "u" && oIndex === i - 1) hasOu = true;
  }
  if (hasA !== -1) return hasA;
  if (hasE !== -1) return hasE;
  if (hasOu && oIndex !== -1) return oIndex;
  return lastVowel;
}

function applyToneToSyllable(syllable: string, tone: number): string {
  const toneIndex = findToneVowelIndex(syllable);
  if (toneIndex === -1) return syllable;
  const chars = [...syllable];
  const char = chars[toneIndex];
  if (!char) return syllable;
  const tones = toneMap[getBaseVowel(char)];
  const marked = tones?.[tone];
  if (!marked) return syllable;
  const upper = char !== char.toLowerCase();
  chars[toneIndex] = upper ? marked.toUpperCase() : marked;
  return chars.join("");
}

function removeLastTone(text: string): string {
  const chars = [...text];
  for (let i = chars.length - 1; i >= 0; i -= 1) {
    const char = chars[i];
    if (!char) continue;
    const info = tonedVowelMap[char.toLowerCase()];
    if (!info) continue;
    const upper = char !== char.toLowerCase();
    chars[i] = upper ? info.base.toUpperCase() : info.base;
    return chars.join("");
  }
  return text;
}

function removeToneFromSyllable(syllable: string): string {
  const chars = [...syllable];
  for (let i = 0; i < chars.length; i += 1) {
    const char = chars[i];
    if (!char) continue;
    const info = tonedVowelMap[char.toLowerCase()];
    if (!info) continue;
    const upper = char !== char.toLowerCase();
    chars[i] = upper ? info.base.toUpperCase() : info.base;
  }
  return chars.join("");
}

function canonicalSyllable(syllable: string): string {
  let out = "";
  for (const char of syllable) {
    const lower = char.toLowerCase();
    const toned = tonedVowelMap[lower];
    if (toned) out += toned.base;
    else if (lower === "v") out += "ü";
    else out += lower;
  }
  if (out === "lue") return "lüe";
  if (out === "nue") return "nüe";
  return out;
}

/** v stands for ü. nue / lue become nüe / lüe before the syllable split. */
function normalizeRun(run: string): string {
  const chars = [...run];
  for (let i = 0; i < chars.length; i += 1) {
    if (chars[i] === "v") chars[i] = "ü";
    else if (chars[i] === "V") chars[i] = "Ü";
  }
  for (let i = 2; i < chars.length; i += 1) {
    const current = chars[i];
    if (current !== "e" && current !== "E") continue;
    const prevTwo = `${chars[i - 2] ?? ""}${chars[i - 1] ?? ""}`.toLowerCase();
    if (prevTwo !== "nu" && prevTwo !== "lu") continue;
    chars[i - 1] = chars[i - 1] === "U" ? "Ü" : "ü";
  }
  return chars.join("");
}

function startsWithSentenceSyllable(sequence: string): boolean {
  for (let end = 1; end <= sequence.length; end += 1) {
    if (sentenceSyllables.has(canonicalSyllable(sequence.slice(0, end)))) return true;
  }
  return false;
}

function parseSyllableEnd(
  sequence: string,
  start: number,
  splitNue: boolean,
  breakAfterSyllable: boolean,
): number {
  let i = start;
  const consonantStart = i;
  while (i < sequence.length && !isVowel(sequence[i] ?? "")) i += 1;
  if (i >= sequence.length) return i;
  const initial = sequence.slice(consonantStart, i).toLowerCase();
  const vowelStart = i;
  while (i < sequence.length && isVowel(sequence[i] ?? "")) {
    if (splitNue && i > vowelStart) {
      const prev = getBaseVowel(sequence[i - 1] ?? "");
      const current = getBaseVowel(sequence[i] ?? "");
      if (prev === "ü" && current === "e" && initial === "n") break;
    }
    if (breakAfterSyllable && i > vowelStart) {
      const previous = sequence[i - 1] ?? "";
      const incoming = sequence[i] ?? "";
      // Two tone marks are two syllables: nǚér is 女 + 儿, nüè is one syllable.
      if (isTonedVowel(previous) && isTonedVowel(incoming)) break;
      const soFar = canonicalSyllable(sequence.slice(start, i));
      const extended = canonicalSyllable(sequence.slice(start, i + 1));
      if (
        sentenceSyllables.has(soFar) &&
        !sentencePrefixes.has(extended) &&
        startsWithSentenceSyllable(sequence.slice(i))
      ) {
        break;
      }
    }
    i += 1;
  }
  if (i < sequence.length) {
    const current = sequence[i]?.toLowerCase();
    const next = sequence[i + 1]?.toLowerCase();
    if (current === "n") {
      if (next === "g") {
        const after = sequence[i + 2];
        i += after !== undefined && isVowel(after) ? 1 : 2;
      } else if (next === "r") {
        const afterR = sequence[i + 2];
        i += afterR === undefined || !isVowel(afterR) ? 2 : 1;
      } else if (next === undefined || !isVowel(sequence[i + 1] ?? "")) {
        i += 1;
      }
    } else if (
      current === "r" &&
      (next === undefined || !isVowel(sequence[i + 1] ?? ""))
    ) {
      i += 1;
    }
  }
  return i;
}

type Slice = { start: number; end: number; syllable: string };

function parseSyllables(
  sequence: string,
  splitNue = true,
  breakAfterSyllable = false,
): Slice[] | null {
  const syllables: Slice[] = [];
  let i = 0;
  while (i < sequence.length) {
    const syllableStart = i;
    while (i < sequence.length && !isVowel(sequence[i] ?? "")) i += 1;
    if (i >= sequence.length) return null;
    const syllableEnd = parseSyllableEnd(
      sequence,
      syllableStart,
      splitNue,
      breakAfterSyllable,
    );
    if (syllableEnd <= syllableStart) return null;
    syllables.push({
      start: syllableStart,
      end: syllableEnd,
      syllable: sequence.slice(syllableStart, syllableEnd),
    });
    i = syllableEnd;
  }
  return syllables;
}

function syllableHasTone(syllable: string): boolean {
  for (const char of syllable) {
    if (isTonedVowel(char)) return true;
  }
  return false;
}

/**
 * Rewrite the pinyin run that ends at `cursor` when `digit` is 1–5.
 * Returns null when the digit should be inserted as a digit.
 */
export function applyToneDigit(
  text: string,
  cursor: number,
  digit: number,
): PinyinEdit | null {
  if (digit < 1 || digit > 5) return null;
  if (cursor < 0 || cursor > text.length) return null;
  let start = cursor;
  while (start > 0 && isPinyinChar(text[start - 1] ?? "")) start -= 1;
  if (start === cursor) return null;

  const normalized = normalizeRun(text.slice(start, cursor));
  const syllables = parseSyllables(normalized);
  if (!syllables) return null;
  if (syllables.some((part) => !legalSyllables.has(canonicalSyllable(part.syllable)))) {
    return null;
  }

  let replacement: string;
  if (digit === 5) {
    replacement = removeLastTone(normalized);
  } else {
    const target =
      syllables.find((part) => !syllableHasTone(part.syllable)) ??
      syllables[syllables.length - 1];
    if (!target) return null;
    const base = syllableHasTone(target.syllable)
      ? removeToneFromSyllable(target.syllable)
      : target.syllable;
    const toned = applyToneToSyllable(base, digit);
    replacement =
      normalized.slice(0, target.start) + toned + normalized.slice(target.end);
  }

  return { start, end: cursor, replacement, cursor: start + [...replacement].length };
}

/**
 * Tone marks, with spaces, apostrophes, and unused digits removed.
 * Digits 1–5 tone the same way the composer does, so wo3 and měi tiān compare equal.
 */
export function normalizePinyin(text: string): string {
  const compact = text
    .toLowerCase()
    .replaceAll("v", "ü")
    .replace(/[\s'’]/gu, "");
  let result = "";
  for (const char of compact) {
    if (!/[0-9]/u.test(char)) {
      result += char;
      continue;
    }
    const digit = Number(char);
    if (digit < 1 || digit > 5) continue;
    const edit = applyToneDigit(result, result.length, digit);
    if (!edit) continue;
    result = result.slice(0, edit.start) + edit.replacement + result.slice(edit.end);
  }
  return result;
}

function isDigit(char: string): boolean {
  return char >= "0" && char <= "9";
}

/**
 * A final r that is not its own syllable (nǎr, yīhuìr) is the character 儿.
 * èr, ér, and ěr stay one syllable.
 */
function expandErhua(
  start: number,
  end: number,
  text: string,
): { start: number; end: number }[] {
  const tail = text.slice(-1);
  if (tail !== "r" && tail !== "R") return [{ start, end }];
  const base = text.slice(0, -1);
  if (!base) return [{ start, end }];
  if (legalSyllables.has(canonicalSyllable(text))) return [{ start, end }];
  if (!legalSyllables.has(canonicalSyllable(base))) return [{ start, end }];
  return [
    { start, end: end - 1 },
    { start: end - 1, end },
  ];
}

/**
 * Syllables of a sentence file's pinyin, in order.
 * A digit run is one unit. An erhua r is its own unit, for 儿.
 * nüe stays one syllable. Spaces, apostrophes, and punctuation are not units.
 * Null when a letter run cannot be split into syllables.
 */
export function suppliedPinyinUnits(
  pinyin: string,
): { start: number; end: number }[] | null {
  const units: { start: number; end: number }[] = [];
  let i = 0;
  while (i < pinyin.length) {
    const char = pinyin[i] ?? "";
    if (isDigit(char)) {
      const start = i;
      i += 1;
      while (i < pinyin.length && isDigit(pinyin[i] ?? "")) i += 1;
      units.push({ start, end: i });
      continue;
    }
    if (!isPinyinChar(char)) {
      i += 1;
      continue;
    }
    const runStart = i;
    i += 1;
    while (i < pinyin.length && isPinyinChar(pinyin[i] ?? "")) i += 1;
    const normalized = normalizeRun(pinyin.slice(runStart, i));
    if (normalized.length === 1 && (normalized === "r" || normalized === "R")) {
      units.push({ start: runStart, end: i });
      continue;
    }
    const syllables = parseSyllables(normalized, false, true);
    if (!syllables) return null;
    for (const syllable of syllables) {
      const text = normalized.slice(syllable.start, syllable.end);
      units.push(
        ...expandErhua(runStart + syllable.start, runStart + syllable.end, text),
      );
    }
  }
  return units;
}

/** True when the typed pinyin is the expected reading. An empty reading never matches. */
export function pinyinMatches(typed: string, expected: string): boolean {
  const target = normalizePinyin(expected);
  if (!target) return false;
  return normalizePinyin(typed) === target;
}

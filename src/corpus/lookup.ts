export type LookupPiece =
  | { kind: "word"; hanzi: string }
  | { kind: "text"; text: string };

const NUMERALS = new Set("零一二三四五六七八九十百千万亿两半几多");
const PARTICLES = new Set("的了着过得地吗呢吧");

const maxLengthOf = new WeakMap<ReadonlySet<string>, number>();

function isHanzi(char: string): boolean {
  return char >= "\u4e00" && char <= "\u9fff";
}

function maxWordLength(words: ReadonlySet<string>): number {
  const cached = maxLengthOf.get(words);
  if (cached !== undefined) return cached;
  let max = 1;
  for (const word of words) if (word.length > max) max = word.length;
  maxLengthOf.set(words, max);
  return max;
}

function matchForward(text: string, words: ReadonlySet<string>, maxLength: number): string[] {
  const parts: string[] = [];
  let index = 0;
  while (index < text.length) {
    let best = 1;
    const limit = Math.min(maxLength, text.length - index);
    for (let length = limit; length >= 1; length -= 1) {
      if (words.has(text.slice(index, index + length))) {
        best = length;
        break;
      }
    }
    parts.push(text.slice(index, index + best));
    index += best;
  }
  return parts;
}

function matchBackward(text: string, words: ReadonlySet<string>, maxLength: number): string[] {
  const parts: string[] = [];
  let end = text.length;
  while (end > 0) {
    let best = 1;
    const limit = Math.min(maxLength, end);
    for (let length = limit; length >= 1; length -= 1) {
      if (words.has(text.slice(end - length, end))) {
        best = length;
        break;
      }
    }
    parts.push(text.slice(end - best, end));
    end -= best;
  }
  parts.reverse();
  return parts;
}

function ordinarySingles(parts: readonly string[]): number {
  let count = 0;
  for (const part of parts) {
    if (part.length === 1 && !NUMERALS.has(part) && !PARTICLES.has(part)) count += 1;
  }
  return count;
}

/**
 * Fewer words wins. A tie goes to the cut with fewer ordinary single
 * characters. Numerals and particles do not count. A remaining tie keeps
 * the backward cut, which is what selects 十 + 分钟 over 十分 + 钟.
 */
function choose(forward: readonly string[], backward: readonly string[]): readonly string[] {
  if (forward.length !== backward.length) {
    return forward.length < backward.length ? forward : backward;
  }
  const forwardSingles = ordinarySingles(forward);
  const backwardSingles = ordinarySingles(backward);
  if (forwardSingles !== backwardSingles) {
    return forwardSingles < backwardSingles ? forward : backward;
  }
  return backward;
}

function appendText(pieces: LookupPiece[], text: string): void {
  const last = pieces[pieces.length - 1];
  if (last?.kind === "text") last.text += text;
  else pieces.push({ kind: "text", text });
}

/** Dictionary segmentation for the popup. Card ids use the other segmenter. */
export function segmentLookup(text: string, words: ReadonlySet<string>): LookupPiece[] {
  const maxLength = maxWordLength(words);
  const pieces: LookupPiece[] = [];
  let index = 0;
  while (index < text.length) {
    if (!isHanzi(text[index] ?? "")) {
      let end = index + 1;
      while (end < text.length && !isHanzi(text[end] ?? "")) end += 1;
      appendText(pieces, text.slice(index, end));
      index = end;
      continue;
    }
    let end = index + 1;
    while (end < text.length && isHanzi(text[end] ?? "")) end += 1;
    const chosen = choose(
      matchForward(text.slice(index, end), words, maxLength),
      matchBackward(text.slice(index, end), words, maxLength),
    );
    for (const part of chosen) {
      if (words.has(part)) pieces.push({ kind: "word", hanzi: part });
      else appendText(pieces, part);
    }
    index = end;
  }
  return pieces;
}

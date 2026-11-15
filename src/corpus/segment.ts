import { hanziOnly } from "./parse";

type Node = {
  children: Map<string, Node>;
  word: string | null;
};

export type Segment =
  | { kind: "word"; hanzi: string }
  | { kind: "unknown"; hanzi: string }
  | { kind: "other"; text: string };

export class Segmenter {
  private readonly root: Node = { children: new Map(), word: null };

  constructor(words: readonly string[]) {
    for (const word of words) {
      if (!/^[\u4e00-\u9fff]+$/u.test(word)) continue;
      let node = this.root;
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
  }

  /** Longest match, left to right. Unknown hanzi coalesce. Other characters stay gaps. */
  segment(text: string): Segment[] {
    const parts: Segment[] = [];
    let index = 0;
    while (index < text.length) {
      const char = text[index];
      if (!hanziOnly(char)) {
        let end = index + 1;
        while (end < text.length && !hanziOnly(text[end])) end += 1;
        parts.push({ kind: "other", text: text.slice(index, end) });
        index = end;
        continue;
      }
      let node = this.root;
      let matched: string | null = null;
      let cursor = index;
      while (cursor < text.length) {
        const child = node.children.get(text[cursor]);
        if (!child) break;
        node = child;
        cursor += 1;
        if (node.word) matched = node.word;
      }
      if (matched) {
        parts.push({ kind: "word", hanzi: matched });
        index += matched.length;
        continue;
      }
      let end = index + 1;
      while (end < text.length && hanziOnly(text[end]) && !this.startsWord(text[end])) {
        end += 1;
      }
      parts.push({ kind: "unknown", hanzi: text.slice(index, end) });
      index = end;
    }
    return parts;
  }

  private startsWord(char: string): boolean {
    return this.root.children.has(char);
  }
}

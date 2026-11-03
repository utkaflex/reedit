import {
  cursorSection,
  type DocumentTextIndex,
  type ReadingCursor,
} from './text-position';

export interface SpeedPreferences {
  wpm: number;
  focusLetter: boolean;
  guidedWords: number;
  pauses: {
    ordinary: number;
    long: number;
    comma: number;
    sentence: number;
    paragraph: number;
  };
  longWordLength: number;
}
export const defaultSpeedPreferences: SpeedPreferences = {
  wpm: 250,
  focusLetter: true,
  guidedWords: 3,
  longWordLength: 10,
  pauses: { ordinary: 1, long: 1.3, comma: 1.5, sentence: 2.2, paragraph: 2.8 },
};
export function validSpeedPreferences(value: SpeedPreferences): boolean {
  return (
    Number.isInteger(value.wpm) &&
    value.wpm >= 100 &&
    value.wpm <= 900 &&
    typeof value.focusLetter === 'boolean' &&
    Number.isInteger(value.guidedWords) &&
    value.guidedWords >= 1 &&
    value.guidedWords <= 12 &&
    Number.isInteger(value.longWordLength) &&
    value.longWordLength >= 4 &&
    value.longWordLength <= 40 &&
    ['ordinary', 'long', 'comma', 'sentence', 'paragraph'].every((key) => {
      const multiplier = value.pauses[key as keyof SpeedPreferences['pauses']];
      return (
        Number.isFinite(multiplier) && multiplier >= 0.5 && multiplier <= 6
      );
    })
  );
}
export interface SpeedDocument {
  index: DocumentTextIndex;
  paragraphEnds: Record<number, number[]>;
}
export interface SpeedWord {
  spineIndex: number;
  start: number;
  end: number;
  word: string;
  display: string;
  sentenceEnd: boolean;
  paragraphEnd: boolean;
  comma: boolean;
}
const abbreviations = new Set([
  'г',
  'гг',
  'ул',
  'д',
  'стр',
  'рис',
  'им',
  'др',
  'т',
  'е',
  'п',
  'см',
  'проф',
  'доц',
  'акад',
  'руб',
  'коп',
  'мин',
  'сек',
  'ч',
  'км',
  'м',
  'кг',
  'тыс',
  'млн',
  'млрд',
  'вв',
  'в',
  'ст',
  'гл',
]);
/** Uses the same word tokens and offsets as ordinary reading, including empty/non-TOC sections. */
export function* speedWords(document: SpeedDocument): Generator<SpeedWord> {
  for (const section of document.index.sections) {
    const boundaries = [
      ...(document.paragraphEnds[section.spineIndex] ?? []),
      section.text.length,
    ].sort((a, b) => a - b);
    let boundary = 0;
    let first = true;
    for (let tokenIndex = 0; tokenIndex < section.tokens.length; tokenIndex++) {
      const token = section.tokens[tokenIndex];
      if (token?.kind !== 'word') continue;
      let nextIndex = tokenIndex + 1;
      while (
        nextIndex < section.tokens.length &&
        section.tokens[nextIndex]?.kind !== 'word'
      )
        nextIndex++;
      const next = section.tokens[nextIndex];
      const gap = section.text.slice(
        token.end,
        next?.start ?? section.text.length,
      );
      const word = section.text.slice(token.start, token.end);
      while ((boundaries[boundary] ?? Infinity) < token.end) boundary++;
      const paragraphEnd =
        !next || (boundaries[boundary] ?? Infinity) <= next.start;
      const initial =
        /^[А-ЮЁA-Z]$/u.test(word) &&
        Boolean(
          next &&
          /(?:ов|ев|ин|ский|ко|ова|ина)$|^[А-ЯЁA-Z]$/u.test(
            section.text.slice(next.start, next.end),
          ),
        );
      const abbreviated =
        /^\.[\s»”"')\]]*$/u.test(gap) &&
        (abbreviations.has(word.toLocaleLowerCase('ru')) || initial);
      yield {
        spineIndex: section.spineIndex,
        start: token.start,
        end: token.end,
        word,
        display:
          `${first ? section.text.slice(0, token.start) : ''}${word}${gap}`.trim(),
        paragraphEnd,
        sentenceEnd: paragraphEnd || (/[.!?…]/u.test(gap) && !abbreviated),
        comma: /[,;:]/u.test(gap),
      };
      first = false;
    }
  }
}
export function wordDuration(
  word: SpeedWord,
  preferences: SpeedPreferences,
): number {
  const p = preferences.pauses;
  // A punctuation cluster is one pause: take the strongest applicable factor, never multiply them.
  const multiplier = Math.max(
    p.ordinary,
    Array.from(word.word).filter((letter) => /[\p{L}\p{N}]/u.test(letter))
      .length >= preferences.longWordLength
      ? p.long
      : 0,
    word.comma ? p.comma : 0,
    word.sentenceEnd ? p.sentence : 0,
    word.paragraphEnd ? p.paragraph : 0,
  );
  return (60000 / preferences.wpm) * multiplier;
}
export function speedWordAt(
  document: SpeedDocument,
  words: SpeedWord[],
  cursor: ReadingCursor,
): number {
  cursorSection(document.index, cursor);
  const found = words.findIndex(
    (word) =>
      word.spineIndex > cursor.spineIndex ||
      (word.spineIndex === cursor.spineIndex && word.end > cursor.offset),
  );
  return found < 0 ? Math.max(0, words.length - 1) : found;
}
export function frameEnd(
  words: SpeedWord[],
  start: number,
  count: number,
): number {
  let end = start;
  while (
    end + 1 < words.length &&
    end - start + 1 < count &&
    !words[end]?.paragraphEnd &&
    words[end + 1]?.spineIndex === words[start]?.spineIndex
  )
    end++;
  return end;
}
export function previousSentence(words: SpeedWord[], position: number): number {
  let start = position;
  while (start > 0 && !words[start - 1]?.sentenceEnd) start--;
  if (start === 0) return 0;
  start--;
  while (start > 0 && !words[start - 1]?.sentenceEnd) start--;
  return start;
}
export function focusParts(display: string): [string, string, string] {
  const letters = Array.from(display);
  const positions = letters
    .map((letter, i) => (/[\p{L}\p{N}]/u.test(letter) ? i : -1))
    .filter((i) => i >= 0);
  const position =
    positions[
      Math.min(positions.length - 1, Math.floor(positions.length * 0.35))
    ] ?? 0;
  return [
    letters.slice(0, position).join(''),
    letters[position] ?? '',
    letters.slice(position + 1).join(''),
  ];
}

export type TextSplice = { index: number; remove: number; insert: string };

function splitsSurrogatePair(value: string, index: number) {
  if (index <= 0 || index >= value.length) return false;
  const left = value.charCodeAt(index - 1), right = value.charCodeAt(index);
  return left >= 0xd800 && left <= 0xdbff && right >= 0xdc00 && right <= 0xdfff;
}

/** A minimal changed span in UTF-16 offsets, expanded to retain whole code points. */
export function textSplice(before: string, after: string): TextSplice {
  let index = 0;
  while (index < before.length && index < after.length && before[index] === after[index]) index++;
  if (splitsSurrogatePair(before, index) || splitsSurrogatePair(after, index)) index--;

  let suffix = 0;
  while (suffix < before.length - index && suffix < after.length - index &&
    before[before.length - suffix - 1] === after[after.length - suffix - 1]) suffix++;
  if (splitsSurrogatePair(before, before.length - suffix) || splitsSurrogatePair(after, after.length - suffix)) suffix--;

  return { index, remove: before.length - index - suffix, insert: after.slice(index, after.length - suffix) };
}

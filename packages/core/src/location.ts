import type { FusenThread } from "./threads.js";

/** A 1-based inclusive range of lines, numbered like the lines of a stored thread. */
export type LineRange = Pick<FusenThread, "startLine" | "endLine">;

/**
 * One edit of a document, shaped like VS Code's `TextDocumentContentChangeEvent` so that the editor's events can be passed as they are.
 * Lines and characters are 0-based, as VS Code numbers them.
 */
export interface TextChange {
  /** The range the edit replaced, in the document before the edit. */
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  /** The text that replaced the range. */
  text: string;
}

/** Returns the text of each line in `lineRange` of `fileText`, or `undefined` when the range goes past the end of the file. */
export function codeAt(fileText: string, lineRange: LineRange): string[] | undefined {
  const fileLines = splitLines(fileText);
  return lineRange.endLine <= fileLines.length ? fileLines.slice(lineRange.startLine - 1, lineRange.endLine) : undefined;
}

/**
 * Finds the lines of `fileText` that hold `code`, the text of a thread's lines when it was last placed.
 * When the code appears more than once, the match nearest to `startLine`, where the thread was, wins; at equal distance the lower one.
 * Returns `undefined` when the code is not in the file, because a thread on some other code would point at the wrong place.
 */
export function locateCode(fileText: string, code: readonly string[], startLine: number): LineRange | undefined {
  const fileLines = splitLines(fileText);
  const lastStartIndex = fileLines.length - code.length;
  const previousStartIndex = startLine - 1;
  // Leading and trailing whitespace is ignored so that re-indenting or reformatting the code does not lose the thread.
  const matchesAt = (startIndex: number) =>
    code.every((codeLine, offset) => fileLines[startIndex + offset]!.trim() === codeLine.trim());
  for (let distance = 0; distance <= Math.max(previousStartIndex, lastStartIndex - previousStartIndex); distance++) {
    for (const startIndex of [previousStartIndex + distance, previousStartIndex - distance]) {
      if (startIndex >= 0 && startIndex <= lastStartIndex && matchesAt(startIndex)) {
        return { startLine: startIndex + 1, endLine: startIndex + code.length };
      }
    }
  }
  return undefined;
}

/**
 * Returns where `lineRange` is after `change`, so that a thread stays on its code while the document is edited.
 * Returns `undefined` when the change replaced every line of the range, because the code the thread was on is gone.
 *
 * `lineTextAfterChange` returns the text of a 0-based line of the document right after `change`. With it, a line break
 * typed into the indentation of a line moves the range with the code, and one typed after the code leaves the range.
 * Pass it only when `change` is the only change of the edit, because other changes of the same edit also change the document.
 * Without it, a change is treated as touching the code unless it is at the first character of a line.
 */
export function moveLineRange(
  lineRange: LineRange,
  change: TextChange,
  lineTextAfterChange?: (lineIndex: number) => string,
): LineRange | undefined {
  const { start, end } = change.range;
  const firstLineIndex = lineRange.startLine - 1;
  const lastLineIndex = lineRange.endLine - 1;
  const insertedLines = splitLines(change.text);
  const lineDelta = insertedLines.length - 1 - (end.line - start.line);
  // Whether only whitespace precedes the change on its first line, and only whitespace follows it on its last line.
  // The lines around the change keep that text, so it is read from the document after the change; without it, the text after is unknown.
  const startsBeforeCode = lineTextAfterChange
    ? lineTextAfterChange(start.line).slice(0, start.character).trim() === ""
    : start.character === 0;
  const endsAfterCode = lineTextAfterChange
    ? lineTextAfterChange(start.line + insertedLines.length - 1)
        .slice((insertedLines.length === 1 ? start.character : 0) + insertedLines.at(-1)!.length)
        .trim() === ""
    : undefined;
  const isInsertion = start.line === end.line && start.character === end.character;
  // The change ends before the code of the first line: every line of the range moves.
  if (end.line < firstLineIndex || (end.line === firstLineIndex && (end.character === 0 || (isInsertion && startsBeforeCode)))) {
    return { startLine: lineRange.startLine + lineDelta, endLine: lineRange.endLine + lineDelta };
  }
  // The change is after the code of the last line: the lines it adds or removes come after the range.
  if (
    start.line > lastLineIndex ||
    (start.line === lastLineIndex && end.line === lastLineIndex && !startsBeforeCode && endsAfterCode !== false)
  ) {
    return lineRange;
  }
  const replacesFirstLine = start.line < firstLineIndex || (start.line === firstLineIndex && startsBeforeCode);
  // A change across lines from before the code of the first line to after the code of the last line, such as deleting
  // the last line of a file together with the line break before it, also leaves none of the code.
  if (replacesFirstLine && end.line === lastLineIndex && end.line > start.line && endsAfterCode === true) {
    return undefined;
  }
  if (end.line > lastLineIndex) {
    if (replacesFirstLine) {
      return undefined;
    }
    // The change replaced the end of the range; the range keeps the lines before it.
    return { startLine: lineRange.startLine, endLine: startsBeforeCode ? start.line : start.line + 1 };
  }
  return {
    startLine: replacesFirstLine ? start.line + 1 : lineRange.startLine,
    endLine: lineRange.endLine + lineDelta,
  };
}

/** Splits `text` into lines at the line breaks VS Code recognizes, so that line numbers match the editor's. */
function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

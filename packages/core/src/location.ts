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
 */
export function moveLineRange(lineRange: LineRange, change: TextChange): LineRange | undefined {
  const { start, end } = change.range;
  const firstLineIndex = lineRange.startLine - 1;
  const lastLineIndex = lineRange.endLine - 1;
  const lineDelta = splitLines(change.text).length - 1 - (end.line - start.line);
  // The change ends before the range, or inserts at the very start of its first line: every line of the range moves.
  if (end.line < firstLineIndex || (end.line === firstLineIndex && end.character === 0)) {
    return { startLine: lineRange.startLine + lineDelta, endLine: lineRange.endLine + lineDelta };
  }
  // The change starts after the first character of the last line: the lines it adds or removes come after the range.
  if (start.line > lastLineIndex || (start.line === lastLineIndex && start.character > 0)) {
    return lineRange;
  }
  const replacesFirstLine = start.line < firstLineIndex || (start.line === firstLineIndex && start.character === 0);
  if (end.line > lastLineIndex) {
    if (replacesFirstLine) {
      return undefined;
    }
    // The change replaced the end of the range; the range keeps the lines before it.
    return { startLine: lineRange.startLine, endLine: start.character === 0 ? start.line : start.line + 1 };
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

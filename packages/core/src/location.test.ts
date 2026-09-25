import assert from "node:assert/strict";
import { test } from "node:test";
import { type TextChange, codeAt, locateCode, moveLineRange } from "./location.js";

const fileText = ["function add(a, b) {", "  return a + b;", "}", ""].join("\n");
const code = ["  return a + b;"];

/** Returns an edit that replaces the 0-based range from `startLine:startCharacter` to `endLine:endCharacter` with `text`. */
function textChange(startLine: number, startCharacter: number, endLine: number, endCharacter: number, text: string): TextChange {
  return {
    range: { start: { line: startLine, character: startCharacter }, end: { line: endLine, character: endCharacter } },
    text,
  };
}

test("codeAt returns the text of the lines and undefined past the end of the file", () => {
  assert.deepEqual(codeAt(fileText, { startLine: 1, endLine: 2 }), ["function add(a, b) {", "  return a + b;"]);
  assert.deepEqual(codeAt("a\r\nb\rc", { startLine: 2, endLine: 3 }), ["b", "c"]);
  assert.equal(codeAt(fileText, { startLine: 4, endLine: 5 }), undefined);
});

test("locateCode keeps the lines when the code has not moved", () => {
  assert.deepEqual(locateCode(fileText, code, 2), { startLine: 2, endLine: 2 });
});

test("locateCode follows the code when lines are inserted above it", () => {
  assert.deepEqual(locateCode(`// Adds\n// two numbers\n${fileText}`, code, 2), { startLine: 4, endLine: 4 });
});

test("locateCode follows the code when lines are deleted above it", () => {
  assert.deepEqual(locateCode(fileText.replace("function add(a, b) {\n", ""), code, 2), { startLine: 1, endLine: 1 });
});

test("locateCode loses the code when the commented line was changed, but not when it was only re-indented", () => {
  assert.equal(locateCode(fileText.replace("a + b", "b + a"), code, 2), undefined);
  assert.deepEqual(locateCode(fileText.replace("  return", "    return"), code, 2), { startLine: 2, endLine: 2 });
});

test("locateCode loses the code when the commented line was deleted", () => {
  assert.equal(locateCode(fileText.replace("  return a + b;\n", ""), code, 2), undefined);
});

test("locateCode finds every line of a multi-line thread and picks the match nearest to where it was", () => {
  assert.deepEqual(locateCode(`\n${fileText}`, ["  return a + b;", "}"], 2), { startLine: 3, endLine: 4 });
  const twice = ["}", "x", "}", "y", "}"].join("\n");
  assert.deepEqual(locateCode(twice, ["}"], 4), { startLine: 5, endLine: 5 });
  assert.deepEqual(locateCode(twice, ["}"], 2), { startLine: 3, endLine: 3 });
  assert.equal(locateCode("}", ["}", "x"], 1), undefined);
});

test("moveLineRange moves the range down when lines are inserted above it", () => {
  // Enter at the end of the line above, and a line typed at the very start of the first line.
  assert.deepEqual(moveLineRange({ startLine: 5, endLine: 6 }, textChange(3, 10, 3, 10, "\n  ")), { startLine: 6, endLine: 7 });
  assert.deepEqual(moveLineRange({ startLine: 5, endLine: 6 }, textChange(4, 0, 4, 0, "// note\n")), { startLine: 6, endLine: 7 });
});

test("moveLineRange moves the range up when lines are deleted above it", () => {
  assert.deepEqual(moveLineRange({ startLine: 5, endLine: 6 }, textChange(1, 0, 3, 0, "")), { startLine: 3, endLine: 4 });
  // Backspace at the start of the first line joins it to the line above.
  assert.deepEqual(moveLineRange({ startLine: 5, endLine: 6 }, textChange(3, 7, 4, 0, "")), { startLine: 4, endLine: 5 });
});

test("moveLineRange keeps the range when the commented lines are changed or lines are added after them", () => {
  assert.deepEqual(moveLineRange({ startLine: 5, endLine: 5 }, textChange(4, 2, 4, 8, "value")), { startLine: 5, endLine: 5 });
  // Enter at the end of the last line.
  assert.deepEqual(moveLineRange({ startLine: 5, endLine: 5 }, textChange(4, 16, 4, 16, "\n")), { startLine: 5, endLine: 5 });
  assert.deepEqual(moveLineRange({ startLine: 5, endLine: 5 }, textChange(7, 0, 9, 0, "")), { startLine: 5, endLine: 5 });
});

test("moveLineRange grows and shrinks with lines added or deleted inside the range", () => {
  assert.deepEqual(moveLineRange({ startLine: 5, endLine: 7 }, textChange(4, 3, 4, 3, "\n\n")), { startLine: 5, endLine: 9 });
  assert.deepEqual(moveLineRange({ startLine: 5, endLine: 7 }, textChange(4, 0, 5, 0, "")), { startLine: 5, endLine: 6 });
  assert.deepEqual(moveLineRange({ startLine: 5, endLine: 7 }, textChange(6, 0, 7, 0, "")), { startLine: 5, endLine: 6 });
});

test("moveLineRange returns undefined when the commented lines are deleted", () => {
  assert.equal(moveLineRange({ startLine: 5, endLine: 5 }, textChange(4, 0, 5, 0, "")), undefined);
  assert.equal(moveLineRange({ startLine: 5, endLine: 6 }, textChange(2, 0, 8, 0, "replacement\n")), undefined);
});

test("moveLineRange applies the changes of one event in order", () => {
  // VS Code lists the edits of several cursors from the bottom up, so each one is applied to the result of the previous.
  const changes = [textChange(9, 0, 9, 0, "\n"), textChange(0, 0, 0, 0, "\n")];
  assert.deepEqual(
    changes.reduce<ReturnType<typeof moveLineRange>>((lineRange, change) => lineRange && moveLineRange(lineRange, change), {
      startLine: 5,
      endLine: 5,
    }),
    { startLine: 6, endLine: 6 },
  );
});

import { Option } from "effect";
import { describe, expect, test } from "vite-plus/test";
import { findRexOutputMatch } from "./rex-output-query.ts";
import {
  linesSinceRexMark,
  makeRexTerminalText,
  markRexTerminalText,
} from "./rex-terminal-text.ts";

const history = ["~/app on main", "$ make build", "built in 2s", "~/app on main", "$ "].join("\n");

describe("terminal text", () => {
  test("splits lines, trims them, drops trailing blank rows, and counts UTF-8 offsets", () => {
    const text = makeRexTerminalText("héllo  \n✓ ok\n\n\n", 100);
    expect(text.lines).toEqual(["héllo", "✓ ok"]);
    // The trimmed trailing spaces still count toward the next line's offset.
    expect(text.lineOffsets).toEqual([100, 100 + Buffer.byteLength("héllo  ") + 1]);
    expect(text.truncated).toBe(false);
  });

  test("a mark finds its exact offset after output is appended, skipping the typed command line", () => {
    const before = makeRexTerminalText(history);
    const mark = markRexTerminalText(before);
    const after = makeRexTerminalText(
      `${history.trimEnd()} make test\nPASS 3\n~/app on main\n$ \n\n`,
    );
    expect(linesSinceRexMark(after, mark)).toEqual({
      lines: ["PASS 3", "~/app on main", "$"],
      alignment: "offset",
    });
  });

  test("nothing is new right after the mark", () => {
    const text = makeRexTerminalText(history);
    expect(linesSinceRexMark(text, markRexTerminalText(text))).toEqual({
      lines: [],
      alignment: "offset",
    });
  });

  test("a mark finds its anchor lines when trimmed scrollback moved the offsets", () => {
    const mark = markRexTerminalText(makeRexTerminalText(`old line\n${history}`));
    const trimmed = makeRexTerminalText(`${history} make test\nPASS 3\n`);
    expect(linesSinceRexMark(trimmed, mark)).toEqual({ lines: ["PASS 3"], alignment: "anchor" });
  });

  test("after a clear, every line counts as new and the result says so", () => {
    const mark = markRexTerminalText(makeRexTerminalText(history));
    const cleared = makeRexTerminalText("PASS 3\n$ ");
    expect(linesSinceRexMark(cleared, mark)).toEqual({
      lines: ["PASS 3", "$"],
      alignment: "unaligned",
    });
  });

  test("a mark of an empty terminal counts every later line", () => {
    const mark = markRexTerminalText(makeRexTerminalText(""));
    expect(linesSinceRexMark(makeRexTerminalText("first\nsecond"), mark)).toEqual({
      lines: ["first", "second"],
      alignment: "offset",
    });
  });

  test("a truncated window checks only the anchor lines it holds", () => {
    const full = makeRexTerminalText(history);
    const mark = markRexTerminalText(full);
    // The window starts at the third line, so two anchor lines are older than the window.
    const window = makeRexTerminalText(
      "built in 2s\n~/app on main\n$ make test\nPASS\n",
      full.lineOffsets[2],
      true,
    );
    expect(linesSinceRexMark(window, mark)).toEqual({ lines: ["PASS"], alignment: "offset" });
  });
});

describe("output queries", () => {
  const text = makeRexTerminalText("PASS 1\nbuilding\nFAIL 2\nPASS 3\n$ ");

  test("finds the bottom-most matching line, with capture groups, ignoring g and y", () => {
    expect(findRexOutputMatch(text, /(PASS|FAIL) (\d)/gy)).toEqual(
      Option.some({
        line: "PASS 3",
        text: "PASS 3",
        groups: ["PASS", "3"],
        alignment: Option.none(),
      }),
    );
    expect(findRexOutputMatch(text, "FAIL")).toEqual(
      Option.some({ line: "FAIL 2", text: "FAIL", groups: [], alignment: Option.none() }),
    );
    expect(findRexOutputMatch(text, "nothing")).toEqual(Option.none());
  });

  test("searches only the last lines, or only lines after a mark", () => {
    expect(findRexOutputMatch(text, { pattern: "FAIL", lines: 2 })).toEqual(Option.none());
    const mark = markRexTerminalText(makeRexTerminalText("PASS 1\n$ "));
    const later = makeRexTerminalText("PASS 1\n$ make test\nok\n$ ");
    expect(findRexOutputMatch(later, { pattern: "PASS", since: mark })).toEqual(Option.none());
    expect(findRexOutputMatch(later, { pattern: /^ok$/, since: mark })).toEqual(
      Option.some({ line: "ok", text: "ok", groups: [], alignment: Option.some("offset") }),
    );
  });
});

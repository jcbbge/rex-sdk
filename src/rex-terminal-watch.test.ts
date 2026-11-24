/**
 * Terminal text, activity, watches, and waits, against a scripted terminal on the test server.
 */
import { Effect, Exit, Fiber, Option, Schema, Stream } from "effect";
import { describe, expect, test } from "vite-plus/test";
import { BlockId, SessionId } from "./rex-domain.ts";
import { RexSdk } from "./rex-sdk.ts";
import type { RexTerminalActivity } from "./rex-terminal-activity.ts";
import { makeRexTerminalText } from "./rex-terminal-text.ts";
import type { RexTerminalFrame } from "./rex-terminal-watch.ts";
import { runRexSdkTest } from "./testing/rex-test-runtime.ts";
import { referenceRexTerminalTail, startRexTestTerminal } from "./testing/rex-test-terminal.ts";

const sessionId = SessionId.make("session:01a1aaaa-0000-0000-0000-000000000001");
const blockId = BlockId.make("block:01a1bbbb-0000-0000-0000-000000000001");
const target = { sessionId, blockId };
const otherTarget = {
  sessionId,
  blockId: BlockId.make("block:01a1bbbb-0000-0000-0000-000000000002"),
};

const decodeBlobReadOffset = Schema.decodeUnknownSync(
  Schema.Struct({ args: Schema.Struct({ offset: Schema.Number }) }),
);

const failureTags = <A, E extends { readonly _tag: string }>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit)
    ? exit.cause.reasons.map((reason) => (reason._tag === "Fail" ? reason.error._tag : reason._tag))
    : ["Success"];

/** A deterministic random number generator, so a failing case can be replayed. */
function seededRandom(seed: number) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Output mixing ASCII, 2-, 3-, and 4-byte characters, a real U+FFFD, escaped characters, trailing spaces, and blank lines. */
function generatedOutput(seed: number, lineCount: number): string {
  const pieces = ["word", "é", "✓", "€", "😀", "\uFFFD", '"', "\\", "<", "&", ">", " ", "  "];
  const random = seededRandom(seed);
  const lines = Array.from({ length: lineCount }, () => {
    const length = Math.floor(random() * 12);
    return Array.from({ length }, () => pieces[Math.floor(random() * pieces.length)] ?? "").join(
      "",
    );
  });
  return `${lines.join("\n")}\n\n`;
}

describe("the test terminal", () => {
  test("answers blob_read as the probe in docs/research/rex-blob-read.md recorded", () =>
    runRexSdkTest((server) =>
      Effect.gen(function* () {
        // The probe's output from its `aa✓bb` line on, so offsets are the probe's minus 43.
        startRexTestTerminal(server, target, { content: 'aa✓bb\n"q"\\x\n\uFFFD€' });
        startRexTestTerminal(server, otherTarget, { content: "a<b&c>d ef" });
        const rex = yield* RexSdk;
        const read = (from: typeof target, offset: number, maxBytes: number) =>
          Effect.gen(function* () {
            const first = yield* rex.terminals.format(from, {
              trim: true,
              unwrap: true,
              maxBytes: 1,
            });
            const id = Option.getOrThrow(first.id);
            const part = yield* rex.terminals.blobRead(from, { id, offset, maxBytes });
            return [part.data, part.eof] as const;
          });
        const observed: ReadonlyArray<readonly [number, number, string, boolean]> = [
          [2, 1, "✓", false],
          [3, 1, "\uFFFD", false],
          [3, 3, "\uFFFD\uFFFDb", false],
          [3, 6, "\uFFFD\uFFFDbb\n", false],
          [4, 4, "\uFFFDbb", false],
          [0, 3, "aa", false],
          [8, 2, '"', false],
          [8, 3, '"q', false],
          [11, 4, "\\x", false],
          [14, 4, "\uFFFD", false],
          [14, 6, "\uFFFD€", true],
          [15, 6, "\uFFFD\uFFFD€", true],
          [18, 1, "\uFFFD", false],
          [18, 2, "\uFFFD\uFFFD", true],
          [20, 1, "", true],
        ];
        for (const [offset, maxBytes, data, eof] of observed) {
          expect([offset, maxBytes, ...(yield* read(target, offset, maxBytes))]).toEqual([
            offset,
            maxBytes,
            data,
            eof,
          ]);
        }
        expect(yield* read(otherTarget, 0, 6)).toEqual(["a", false]);
        expect(yield* read(otherTarget, 6, 3)).toEqual(["d e", false]);
      }),
    ));
});

describe("readTail", () => {
  test("reads only the end of long output, with exact offsets, from one snapshot", () =>
    runRexSdkTest((server) =>
      Effect.gen(function* () {
        const lines = Array.from({ length: 4_000 }, (_, index) => `line ${index} ✓`);
        const terminal = startRexTestTerminal(server, target, { content: lines.join("\n") });
        const rex = yield* RexSdk;
        const tail = yield* rex.terminals.readTail(target, { maxBytes: 1_000 });
        const full = makeRexTerminalText(terminal.content());
        expect(tail.truncated).toBe(true);
        expect(tail.lines.length).toBeGreaterThan(50);
        expect(tail.lines.at(-1)).toBe("line 3999 ✓");
        // Each line's offset is its offset in the whole output.
        const first = full.lines.length - tail.lines.length;
        expect(tail.lines).toEqual(full.lines.slice(first));
        expect(tail.lineOffsets).toEqual(full.lineOffsets.slice(first));
        // The first part, then one jump to the end: the long middle is never read.
        const blobReads = server.requestsFor("com.superlogical.terminal.blob_read");
        expect(blobReads.length).toBe(1);
      }),
    ));

  test("keeps only the last maxBytes when the first part overlaps the tail", () =>
    runRexSdkTest((server) =>
      Effect.gen(function* () {
        // 500 bytes ending with a unique marker line, then exactly 1,000 bytes of tail lines.
        const head = `${"h".repeat(480)}\nMARKER-BEFORE-TAIL\n`;
        const tailLines = Array.from(
          { length: 100 },
          (_, index) => `tail ${String(index).padStart(4, "0")}${index === 0 ? "!" : ""}`,
        );
        const tailContent = tailLines.join("\n");
        expect([Buffer.byteLength(head), Buffer.byteLength(tailContent)]).toEqual([500, 1_000]);
        startRexTestTerminal(server, target, { content: head + tailContent });
        const rex = yield* RexSdk;
        const tail = yield* rex.terminals.readTail(target, { maxBytes: 1_000 });
        expect(tail.lines).not.toContain("MARKER-BEFORE-TAIL");
        expect(tail.truncated).toBe(true);
        // The line that starts exactly at the cutoff is whole, so it stays.
        expect(tail.lines).toEqual(tailLines);
        expect(tail.lineOffsets).toEqual(makeRexTerminalText(tailContent, 500).lineOffsets);
        expect(tail.lineOffsets[0]).toBe(500);
      }),
    ));

  test("matches a byte-level reference across sizes, characters, and both reading paths", () =>
    runRexSdkTest((server) =>
      Effect.gen(function* () {
        const rex = yield* RexSdk;
        // Short output overlaps the first part; long output makes small tails jump to the end.
        for (const [seed, lineCount] of [
          [1, 60],
          [2, 4_000],
        ] as const) {
          const content = generatedOutput(seed, lineCount);
          const bytes = Buffer.from(content);
          startRexTestTerminal(server, target, { content });
          const random = seededRandom(seed);
          const sizes = new Set([bytes.length - 1, bytes.length, bytes.length + 1]);
          const lineStarts = referenceRexTerminalTail(content, bytes.length).lineOffsets.slice(-8);
          for (const start of lineStarts) {
            // At a line start, one byte either side, and inside the character that may follow.
            for (const delta of [-1, 0, 1, 2, 3]) sizes.add(bytes.length - (start + delta));
          }
          while (sizes.size < 60)
            sizes.add(1 + Math.floor(random() * Math.min(bytes.length, 6_000)));
          for (const maxBytes of sizes) {
            if (maxBytes <= 0) continue;
            const tail = yield* rex.terminals.readTail(target, { maxBytes });
            expect({ maxBytes, tail }).toEqual({
              maxBytes,
              tail: referenceRexTerminalTail(content, maxBytes),
            });
          }
        }
      }),
    ));

  test("a jump that lands inside a character, or inside a real U+FFFD, reads once from there", () =>
    runRexSdkTest((server) =>
      Effect.gen(function* () {
        const rex = yield* RexSdk;
        const ending = "check ✓ face 😀 replacement \uFFFD end";
        const content = `${"filler line\n".repeat(10_000)}${ending}\nlast`;
        const bytes = Buffer.from(content);
        startRexTestTerminal(server, target, { content });
        const endingStart = bytes.length - Buffer.byteLength(`${ending}\nlast`);
        for (const character of ["✓", "😀", "\uFFFD"]) {
          const at = endingStart + Buffer.byteLength(ending.slice(0, ending.indexOf(character)));
          for (let inside = 1; inside < Buffer.byteLength(character); inside += 1) {
            // The window starts right after the byte the jump lands on.
            const maxBytes = bytes.length - (at + inside) - 1;
            const before = server.requestsFor("com.superlogical.terminal.blob_read").length;
            const tail = yield* rex.terminals.readTail(target, { maxBytes });
            expect(tail).toEqual(referenceRexTerminalTail(content, maxBytes));
            expect(tail.lines).toEqual(["last"]);
            const reads = server.requestsFor("com.superlogical.terminal.blob_read").slice(before);
            expect(reads.map((read) => decodeBlobReadOffset(read.payload).args.offset)).toEqual([
              at + inside,
            ]);
          }
        }
      }),
    ));

  test("reads forward from the first part when the jump can't reach the end in one read", () =>
    runRexSdkTest((server) =>
      Effect.gen(function* () {
        const rex = yield* RexSdk;
        // Rex counts each of < > & as six bytes, so 300 KB of them is over one read's 960 KiB.
        const content = `${"plain line\n".repeat(20_000)}${"<&><&><&>\n".repeat(30_000)}done`;
        const total = Buffer.byteLength(content);
        startRexTestTerminal(server, target, { content });
        const maxBytes = 300_000;
        const tail = yield* rex.terminals.readTail(target, { maxBytes });
        expect(tail).toEqual(referenceRexTerminalTail(content, maxBytes));
        const offsets = server
          .requestsFor("com.superlogical.terminal.blob_read")
          .map((read) => decodeBlobReadOffset(read.payload).args.offset);
        expect(offsets[0]).toBe(total - maxBytes - 1);
        // Then forward, from the end of the first part, never from the jumped read.
        // The first part is 64 KiB as Rex measures it: each "plain line\n" counts as 12 bytes for
        // its 11, so it ends 4 bytes into line 5,462, and forward reading starts there.
        const forward = offsets.slice(1);
        expect(forward[0]).toBe(5_461 * 11 + 4);
        expect(forward).toEqual([...forward].sort((left, right) => left - right));
      }),
    ));

  test("counts trimmed trailing spaces in line offsets", () =>
    runRexSdkTest((server) =>
      Effect.gen(function* () {
        const content = Array.from({ length: 200 }, (_, index) => `row ${index}   `).join("\n");
        startRexTestTerminal(server, target, { content });
        const rex = yield* RexSdk;
        const tail = yield* rex.terminals.readTail(target, { maxBytes: 600 });
        const lastStart = Buffer.byteLength(content) - Buffer.byteLength("row 199   ");
        expect(tail.lines.at(-1)).toBe("row 199");
        expect(tail.lineOffsets.at(-1)).toBe(lastStart);
      }),
    ));

  test("returns all of a snapshot that fits in maxBytes, untruncated", () =>
    runRexSdkTest((server) =>
      Effect.gen(function* () {
        const content = Array.from(
          { length: 100 },
          (_, index) => `fits ${String(index).padStart(4, "0")}`,
        ).join("\n");
        expect(Buffer.byteLength(content)).toBe(999);
        startRexTestTerminal(server, target, { content });
        const rex = yield* RexSdk;
        expect(yield* rex.terminals.readTail(target, { maxBytes: 999 })).toEqual(
          makeRexTerminalText(content),
        );
        expect(yield* rex.terminals.readTail(target, { maxBytes: 1_000 })).toEqual(
          makeRexTerminalText(content),
        );
      }),
    ));

  test("reads short output in one request", () =>
    runRexSdkTest((server) =>
      Effect.gen(function* () {
        startRexTestTerminal(server, target, { content: "$ ls\nREADME.md\n$ " });
        const rex = yield* RexSdk;
        const tail = yield* rex.terminals.readTail(target);
        expect(tail).toEqual(makeRexTerminalText("$ ls\nREADME.md\n$ "));
        expect(server.requestsFor("com.superlogical.terminal.format")[0]?.payload).toMatchObject({
          args: { trim: true, unwrap: true, max_bytes: 65_536 },
        });
        expect(server.requestsFor("com.superlogical.terminal.blob_read")).toEqual([]);
      }),
    ));
});

describe("activity", () => {
  test("is Ready after the snapshot, then counts output and reports the exit", () =>
    runRexSdkTest((server) =>
      Effect.gen(function* () {
        const terminal = startRexTestTerminal(server, target);
        const rex = yield* RexSdk;
        const items: RexTerminalActivity[] = [];
        const fiber = yield* Effect.forkChild(
          Stream.runForEach(rex.terminals.activity(target), (item) =>
            Effect.sync(() => items.push(item)),
          ),
        );
        yield* Effect.sleep("100 millis");
        terminal.print("hello\n");
        terminal.exit(0);
        yield* Effect.sleep("100 millis");
        yield* Fiber.interrupt(fiber);
        // The snapshot's bytes are not output.
        expect(items).toEqual([
          { _tag: "Ready" },
          { _tag: "Output", bytes: 6 },
          { _tag: "Exited", exitCode: 0 },
        ]);
      }),
    ));

  test("shares one data connection per block, and closes it after the last subscriber", () =>
    runRexSdkTest((server) =>
      Effect.gen(function* () {
        const terminal = startRexTestTerminal(server, target);
        const rex = yield* RexSdk;
        const firstItems: RexTerminalActivity[] = [];
        const secondItems: RexTerminalActivity[] = [];
        const first = yield* Effect.forkChild(
          Stream.runForEach(rex.terminals.activity(target), (item) =>
            Effect.sync(() => firstItems.push(item)),
          ),
        );
        const second = yield* Effect.forkChild(
          Stream.runForEach(rex.terminals.activity(target), (item) =>
            Effect.sync(() => secondItems.push(item)),
          ),
        );
        yield* Effect.sleep("100 millis");
        terminal.print("x");
        yield* Effect.sleep("100 millis");
        expect(firstItems).toEqual([{ _tag: "Ready" }, { _tag: "Output", bytes: 1 }]);
        expect(secondItems).toEqual(firstItems);
        expect(server.requestsFor("data.connect").length).toBe(1);

        yield* Fiber.interrupt(first);
        yield* Fiber.interrupt(second);
        yield* Effect.sleep("50 millis");
        // A new subscriber opens a new connection, which the server accepts: the old one closed.
        const again = yield* Stream.runHead(rex.terminals.activity(target));
        expect(again).toEqual(Option.some({ _tag: "Ready" }));
        expect(server.requestsFor("data.connect").length).toBe(2);
      }),
    ));

  test("a subscriber that joins after the exit hears it right after Ready", () =>
    runRexSdkTest((server) =>
      Effect.gen(function* () {
        const terminal = startRexTestTerminal(server, target);
        const rex = yield* RexSdk;
        const first = yield* Effect.forkChild(Stream.runDrain(rex.terminals.activity(target)));
        yield* Effect.sleep("100 millis");
        terminal.exit(4);
        yield* Effect.sleep("50 millis");
        const late = yield* Stream.runCollect(Stream.take(rex.terminals.activity(target), 2));
        expect(late).toEqual([{ _tag: "Ready" }, { _tag: "Exited", exitCode: 4 }]);
        yield* Fiber.interrupt(first);
      }),
    ));
});

describe("watch", () => {
  test("reads at the start, again after output, not while quiet, and last after the exit", () =>
    runRexSdkTest((server) =>
      Effect.gen(function* () {
        const terminal = startRexTestTerminal(server, target, { content: "$ " });
        const rex = yield* RexSdk;
        const frames: RexTerminalFrame[] = [];
        const fiber = yield* Effect.forkChild(
          Stream.runForEach(rex.terminals.watch(target, { settle: "20 millis" }), (frame) =>
            Effect.sync(() => frames.push(frame)),
          ),
        );
        yield* Effect.sleep("150 millis");
        expect(frames.map((frame) => frame.text.lines)).toEqual([["$"]]);
        const readsWhileQuiet = terminal.reads();
        yield* Effect.sleep("200 millis");
        expect(terminal.reads()).toBe(readsWhileQuiet);

        terminal.print("one\n");
        terminal.print("two\n");
        yield* Effect.sleep("150 millis");
        // The burst settles into one read.
        expect(frames.at(-1)?.text.lines).toEqual(["$ one", "two"]);
        expect(terminal.reads()).toBe(readsWhileQuiet + 1);

        terminal.print("done\n");
        terminal.exit(0);
        yield* Fiber.join(fiber);
        expect(frames.at(-1)).toMatchObject({
          text: { lines: ["$ one", "two", "done"] },
          exit: Option.some(0),
        });
      }),
    ));

  test("a program that already exited gives one frame with its exit", () =>
    runRexSdkTest((server) =>
      Effect.gen(function* () {
        startRexTestTerminal(server, target, { content: "done", exitedWith: 2 });
        const rex = yield* RexSdk;
        const frames = yield* Stream.runCollect(rex.terminals.watch(target));
        expect(frames).toEqual([{ text: makeRexTerminalText("done"), exit: Option.some(2) }]);
      }),
    ));
});

describe("waitForOutput", () => {
  test("with a mark, matches only output the command printed, not earlier output or its echo", () =>
    runRexSdkTest((server) =>
      Effect.gen(function* () {
        const terminal = startRexTestTerminal(server, target, {
          content: "$ make test\nPASS\n$ ",
        });
        const rex = yield* RexSdk;
        const mark = yield* rex.terminals.mark(target);
        yield* rex.terminals.writeLine(target, "make test PASS");
        const wait = yield* Effect.forkChild(
          rex.terminals.waitForOutput(
            target,
            { pattern: /PASS/, since: mark },
            { settle: "10 millis", timeout: "2 seconds" },
          ),
        );
        yield* Effect.sleep("200 millis");
        // Neither the earlier PASS nor the typed command counts.
        expect(Option.isNone(yield* Fiber.await(wait).pipe(Effect.timeoutOption("1 millis")))).toBe(
          true,
        );
        terminal.print("ok 1\nPASS 1/1\n$ ");
        expect(yield* Fiber.join(wait)).toEqual({
          line: "PASS 1/1",
          text: "PASS",
          groups: [],
          alignment: Option.some("offset"),
        });
      }),
    ));

  test("without a mark, output already on screen matches at once", () =>
    runRexSdkTest((server) =>
      Effect.gen(function* () {
        startRexTestTerminal(server, target, { content: "ready on :3000\n" });
        const rex = yield* RexSdk;
        const found = yield* rex.terminals.waitForOutput(target, /on :(\d+)/);
        expect(found.groups).toEqual(["3000"]);
      }),
    ));

  test("fails with RexTerminalExited when the program exits without a match", () =>
    runRexSdkTest((server) =>
      Effect.gen(function* () {
        const terminal = startRexTestTerminal(server, target, { content: "" });
        const rex = yield* RexSdk;
        const wait = yield* Effect.forkChild(
          Effect.exit(rex.terminals.waitForOutput(target, "never", { settle: "10 millis" })),
        );
        yield* Effect.sleep("100 millis");
        terminal.print("error: no such file\n");
        terminal.exit(1);
        const exit = yield* Fiber.join(wait);
        expect(failureTags(exit)).toEqual(["RexTerminalExited"]);
      }),
    ));

  test("fails with RexRequestTimeout when the timeout passes first", () =>
    runRexSdkTest((server) =>
      Effect.gen(function* () {
        startRexTestTerminal(server, target);
        const rex = yield* RexSdk;
        const exit = yield* Effect.exit(
          rex.terminals.waitForOutput(target, "never", { timeout: "150 millis" }),
        );
        expect(failureTags(exit)).toEqual(["RexRequestTimeout"]);
      }),
    ));

  test("concurrent waits on one block share its data connection", () =>
    runRexSdkTest((server) =>
      Effect.gen(function* () {
        const terminal = startRexTestTerminal(server, target, { content: "" });
        const rex = yield* RexSdk;
        const waits = yield* Effect.forkChild(
          Effect.all(
            [
              rex.terminals.waitForOutput(target, "alpha", { settle: "10 millis" }),
              rex.terminals.waitForOutput(target, "beta", { settle: "10 millis" }),
              rex.terminals.waitForQuiet(target, { quietFor: "300 millis" }),
            ],
            { concurrency: "unbounded" },
          ),
        );
        yield* Effect.sleep("100 millis");
        terminal.print("alpha\nbeta\n");
        const [alpha, beta] = yield* Fiber.join(waits);
        expect([alpha.line, beta.line]).toEqual(["alpha", "beta"]);
        expect(server.requestsFor("data.connect").length).toBe(1);
      }),
    ));
});

describe("waitForQuiet", () => {
  test("returns once the program writes nothing for quietFor", () =>
    runRexSdkTest((server) =>
      Effect.gen(function* () {
        const terminal = startRexTestTerminal(server, target);
        const rex = yield* RexSdk;
        const started = Date.now();
        const wait = yield* Effect.forkChild(
          rex.terminals.waitForQuiet(target, { quietFor: "150 millis" }),
        );
        for (let tick = 0; tick < 4; tick++) {
          yield* Effect.sleep("80 millis");
          terminal.print(".");
        }
        yield* Fiber.join(wait);
        // Still busy for 320 ms, then quiet for 150 ms.
        expect(Date.now() - started).toBeGreaterThanOrEqual(450);
      }),
    ));

  test("fails with RexRequestTimeout when output never stops", () =>
    runRexSdkTest((server) =>
      Effect.gen(function* () {
        const terminal = startRexTestTerminal(server, target);
        const rex = yield* RexSdk;
        const printer = yield* Effect.forkChild(
          Effect.forever(
            Effect.andThen(
              Effect.sleep("20 millis"),
              Effect.sync(() => terminal.print(".")),
            ),
          ),
        );
        const exit = yield* Effect.exit(
          rex.terminals.waitForQuiet(target, { quietFor: "100 millis", timeout: "300 millis" }),
        );
        yield* Fiber.interrupt(printer);
        expect(failureTags(exit)).toEqual(["RexRequestTimeout"]);
      }),
    ));
});

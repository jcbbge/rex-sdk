# rex codemode (pi extension)

A [pi](https://pi.dev) extension that exposes this SDK to codemode scripts as `tools.rex_*`, one
tool per permitted SDK operation. It is the Rex counterpart of the Herdr codemode extension.

```sh
pi install git:github.com/jcbbge/rex-sdk
```

```js
const { here } = await tools.rex_search({});
const { sessionId, blockId } = here;
const { markId } = await tools.rex_terminals_writeLine({
  sessionId,
  blockId,
  text: "pnpm test && echo __rex_ok || echo __rex_failed",
});
const done = await tools.rex_terminals_waitForOutput({
  sessionId,
  blockId,
  since: markId,
  match: { type: "regex", value: "^__rex_(ok|failed)$" },
  timeoutMs: 120000,
});
return done.timedOut ? "still running" : done.match.groups[0];
```

## Tool surface

Hands never control the operator’s view. The fork policy filters tools that can take focus,
control the client view, or stop Rex from registration and search.

- **Names** mirror the SDK path: `rex.terminals.writeLine` → `rex_terminals_writeLine`.
- **Only `rex_search` is listed** in the codemode description, after Cloudflare's Code Mode MCP
  server. Every operation tool is `deferred`: callable, never listed. Scripts discover tools this
  way:
  - `rex_search({})` returns the usage instructions, `here` (the session and block pi runs in,
    from `REX_SESSION` and `REX_BLOCK`), and a table of contents of namespaces with tool counts.
  - `rex_search({ query, namespace?, limit? })` returns up to `limit` ranked hits (default 8) as
    `{ name, description, destructive? }`, plus `total`.
  - `describeTool(name)` returns one tool's full signature.
- **Parameters** are one flat object: SDK positional arguments (`sessionId`, `blockId`, `text`, …)
  sit beside the fields of the SDK's input object. Layouts are typed `RexLayoutNode` trees.
- **Results** are the SDK's decoded values as plain JSON in camelCase; `Option` becomes `null`.
- **Marks**: `terminals_writeLine` and `terminals_mark` return a `markId`, kept per pi session.
  `terminals_waitForOutput({ since: markId })` matches only output printed after it, so neither
  earlier output nor the typed command line matches, in any shell.
- **Waits** (`terminals_waitForOutput`, `terminals_waitForQuiet`, `terminals_waitForExit`,
  `events_waitFor`) require `timeoutMs` and resolve to `{ timedOut: true }` when it passes, or
  `{ timedOut: false, match | quiet | exit | event }`. `terminals_waitForOutput` rejects with
  `RexTerminalExited` when the program exits without a match. They read the terminal only after
  it writes, over one data connection per block shared by every wait.
- **Failures** reject with a message that starts with the SDK error tag, such as
  `RexSessionNotFound: …` or `RexConnectionLost: …`.
- **Deadlines**: `requestTimeoutMs`, accepted by every tool, bounds each request the call makes.
- **Annotations**: reads and waits are `readOnlyHint`; closes, `sessions_destroy`,
  `terminals_clear`/`reset`, Tailscale disable/logout, and `hosts_remove` are
  `destructiveHint`.
- **Not exposed** (see `rexToolExclusions` in `rex-tool-operations.ts`): streams, port forwards,
  byte streams, request handlers, and the attachment methods the SDK manages itself.

Tools register only inside Rex (`REX_SESSION`, `REX_BLOCK`, or `REX_SERVER` set). Set
`PI_REX_CODEMODE=1` to force them on, or `0` to turn them off. The SDK runtime connects on the
first call and closes on `session_shutdown`.

## How it is built

The extension imports the SDK's source (`../src/index.ts`) directly, so it never drifts from the
SDK and needs no build step. Parameter and result schemas come from the SDK's Effect Schemas: the
generated `rexWireMethods` and `rexBlockMethods` codecs for documented methods, and the SDK's own
types (`RexLayoutNode`, `RexOutputMatch`, …) for composed operations.

| File                     | Owns                                                       |
| ------------------------ | ---------------------------------------------------------- |
| `index.ts`               | Gating, the `rex` tool namespace, registration             |
| `rex-tool-operations.ts` | The tool table and the SDK operations left out             |
| `rex-tool-schemas.ts`    | Effect Schema → JSON Schema for parameters and results     |
| `rex-tool-runtime.ts`    | The lazily built SDK runtime, exits → pi tool results      |
| `rex-tool-search.ts`     | `rex_search` and the usage instructions                    |
| `test/`                  | Every tool against the SDK's test server, never a live Rex |

`vp test run pi` runs the suite; `vp run ready` includes it.

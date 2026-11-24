# Working on rex-sdk

## Goal

An Effect-native TypeScript SDK for the [Rex](https://www.superlogical.com/rex/docs) server API,
the Rex counterpart to `../herdr-sdk`: one yieldable `RexSdk` aggregate of namespace services
(`server`, `sessions`, `windows`, `blocks`, `layers`, `terminals`, `tunnels`, `clients`,
`events`, `targets`, `hosts`, `creators`) over one shared control connection. It offers Rex API revision 19 and requires revision 18 or newer.

## Start here

- Read [architecture](docs/architecture.md) for layers, decisions, and the verification map.
- The wire contract is the server snapshots in [schema/](schema/) and the protocol guide in
  [docs/research/rex-api-revision-19.md](docs/research/rex-api-revision-19.md). They are
  authoritative over guesses or the public docs.
- Apply [coding standards](docs/coding-standards.md) and [error guidance](docs/errors.md).
- For an established pattern (service/Layer shape, schema boundaries, spans, fixtures), read
  `../herdr-sdk/src`. Do not copy its newline-socket transport.

## Where things live

| Change                                 | Files                                                                                                                                |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| A method's arguments or result         | Regenerate; never edit `src/generated/`                                                                                              |
| How snapshots become codecs            | `scripts/generate-wire-schemas.ts`, then `vp run generate`                                                                           |
| Server or session event shapes         | `schema/rex-events.json`, then `vp run generate`                                                                                     |
| A namespace operation                  | `src/<namespace>-service.ts`, plus its row in `src/rex-contract-sweep.test.ts`                                                       |
| Request encoding, attachment rules     | `src/rex-operation.ts`, `src/rex-attachments.ts`                                                                                     |
| Connection, handshake, events plumbing | `src/rex-control.ts`, `src/rex-events.ts`                                                                                            |
| Data connections, terminal streams     | `src/rex-data-connection.ts`, `src/rex-data-codec.ts`, `src/rex-terminal-stream.ts`                                                  |
| Terminal text, marks, waits            | `src/rex-terminal-text.ts`, `src/rex-output-query.ts` (pure), `src/rex-terminal-activity.ts`, `src/rex-terminal-watch.ts`            |
| Reading terminal text in parts         | `src/terminal-service.ts` (`read`, `readTail`); contract in `docs/research/rex-blob-read.md`                                         |
| Byte streams, file transfers, forwards | `src/rex-bytes-stream.ts`, `src/rex-file-transfer.ts`, `src/rex-tunnel-forward.ts`; contract in `docs/research/rex-data-bytes-v1.md` |
| Layout trees                           | `src/rex-layout.ts`                                                                                                                  |
| Errors                                 | `src/rex-errors.ts`                                                                                                                  |
| pi extension (codemode tools)          | `pi/` (`pi/README.md`); a new SDK operation needs a tool row or a `rexToolExclusions` entry                                          |

## Local rules

- Parse public inputs at service boundaries; snake_case stays inside the generated codecs and
  `rex-operation.ts`.
- Never log, trace, or persist `reconnect_token` values or data tickets.
- Never retry or replay a request whose response was lost; surface `RexConnectionLost`.
- Session-scoped operations attach through `RexAttachments`; callers never manage attachment.
- Never fall back implicitly to `REX_SESSION`, `REX_BLOCK`, or `REX_CLIENT`.
- Terminal tests script a block with `src/testing/rex-test-terminal.ts` (text, stream, typing, and
  exit kept consistent).
- Tests use `src/testing/rex-test-server.ts` through public services and must leave
  `server.violations()` empty; fix a fixture that violates the schema instead of loosening the
  check. Only `src/rex-live.test.ts` may touch a real server, in a session it creates and
  destroys.
- Every new server or block method needs an SDK operation and a contract-sweep row; the sweep
  fails until the table names every method.
- Do not install dependencies, refresh snapshots, commit, or modify unrelated work unless the
  task explicitly asks for it.

## Commands

| Command                                      | Use                                                               |
| -------------------------------------------- | ----------------------------------------------------------------- |
| `vp run ready`                               | Full gate: generated-code drift, `vp check`, `vp test`, `vp pack` |
| `vp test run <file>`                         | One suite                                                         |
| `vp run test:live`                           | Opt-in suite against the real server (`REX_SDK_LIVE=1`)           |
| `vp run generate` / `vp run check:generated` | Regenerate codecs / check for drift                               |
| `vp run fetch:rex-api`                       | Refresh server snapshots when moving to a new Rex release         |

<!--VITE PLUS START-->

# Using Vite+, the Unified Toolchain for the Web

This project is using Vite+, a unified toolchain built on top of Vite, Rolldown, Vitest, tsdown, Oxlint, Oxfmt, and Vite Task. Vite+ wraps runtime management, package management, and frontend tooling in a single global CLI called `vp`. Vite+ is distinct from Vite, and it invokes Vite through `vp dev` and `vp build`. Run `vp help` to print a list of commands and `vp <command> --help` for information about a specific command.

Docs are local at `node_modules/vite-plus/docs` or online at https://viteplus.dev/guide/.

## Built-in Commands vs Scripts

`vp <name>` runs a built-in command. `vp run <name>` runs a `package.json` script or a `vite.config.ts` task. Scripts cannot overwrite built-ins, so `vp dev` and `vp run dev` may do different things. Check `package.json` and `vite.config.ts` first, and run `vp run <name>` when the project defines a script or task with that name.

## Running Scripts

Run TypeScript and JavaScript files with `vpx <file>`, for example `vpx ./scripts/seed.ts --dry-run`. It handles enums, decorators, JSX, and tsconfig `paths`, so do not add `tsx` or `ts-node` to run scripts. `vpx --watch <file>` reruns the file when a file it uses changes, in place of `tsx watch`. `vp node <file>` runs plain Node.js.

## Tool Versions

Run `vp toolchain` to show versions and relationships in the active Vite+
release. Add a tool name to select part of the graph. For example, run
`vp toolchain vite`. Use `--global` to ignore the local `vite-plus` package. Use
`vp why <package>` to show the package-manager dependency graph.

## Review Checklist

- [ ] Run `vp install` after pulling remote changes and before getting started.
- [ ] Run `vp check` and `vp test` to format, lint, type check and test changes.
- [ ] Check if there are `vite.config.ts` tasks or `package.json` scripts necessary for validation, run via `vp run <script>`.
- [ ] If setup, runtime, or package-manager behavior looks wrong, run `vp env doctor` and include its output when asking for help.

<!--VITE PLUS END-->

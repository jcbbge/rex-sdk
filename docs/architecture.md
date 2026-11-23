# Rex SDK architecture

`rex-sdk` is an Effect-native TypeScript SDK for the Rex server's control API. It offers Rex API revision 19 with a minimum of 18 (`rex.control.v1`,
`rex.data.terminal.v1`), verified against Rex `0.1.0-preview.22`. It follows the shape of `../herdr-sdk`: a yieldable aggregate of
namespace services over shared, scoped infrastructure.

## Sources of truth

| File                                   | Source                                                                 | Owner                             |
| -------------------------------------- | ---------------------------------------------------------------------- | --------------------------------- |
| `schema/rex-api.json`                  | `GET /api/help`: every method's input and output JSON Schema           | `vp run fetch:rex-api`            |
| `schema/rex-block-creators.json`       | `block_creator.list`: flavor options and block event schemas           | `vp run fetch:rex-api`            |
| `docs/research/rex-api-revision-19.md` | `GET /llms.txt`: the protocol guide and event reference                | `vp run fetch:rex-api`            |
| `schema/rex-events.json`               | Server and session event schemas, transcribed from the event reference | hand-written                      |
| `src/generated/rex-wire-schemas.ts`    | Effect Schema codecs for all of the above                              | `vp run generate`                 |
| `docs/research/rex-data-bytes-v1.md`   | Observed `rex.data.bytes.v1` contract; Rex doesn't document it         | hand-written; recheck on upgrades |

Never hand-edit the generated file or the fetched snapshots.

## Layers

```text
RexSdk                         rex-sdk.ts      aggregate of the namespaces below
├── server, sessions, windows, blocks, layers, terminals, tunnels,
│   clients, events, targets, hosts, creators   *-service.ts
│     └── rexMethodOperation / rexBlockMethodOperation   rex-operation.ts
│           encode args → attach if needed → request → decode result
├── RexAttachments             rex-attachments.ts   attaches sessions on first use
├── RexControl                 rex-control.ts       one control WebSocket, shared
├── openRexDataConnection      rex-data-connection.ts  /api/data handshake, tickets → HELLO, close codes
│   ├── openRexTerminalStream  rex-terminal-stream.ts  rex.data.terminal.v1: resume + parser
│   └── openRexBytesStream     rex-bytes-stream.ts     rex.data.bytes.v1: half-close, completion rule
│       ├── makeRexFileTransfer  rex-file-transfer.ts  download, readFile, downloadToFile, pasteFiles
│       └── bridgeSocketToStream rex-tunnel-forward.ts node:net ⇄ tunnel streams
└── RexConfig                  rex-config.ts        endpoint, identity, deadlines, REX_* context
```

`rexSdkLayer` shares one `RexConfig`, one `RexControl`, and one `RexAttachments` across every
namespace. Each service also exports `make*`, `*LayerWithoutDependencies`, and `*Layer`.

## Wire codecs (`scripts/generate-wire-schemas.ts`)

- Wire keys are snake_case; codecs expose camelCase through `Schema.encodeKeys`. Only the
  generated file and `rex-operation.ts` see the wire form.
- **Inputs** keep plain optional keys, strict enum literals, and numeric bounds, and never send
  `null`. Invalid arguments fail with `RexInvalidInput` before anything is sent.
- **Results and events** decode optional or nullable values to `Option`, and `null` or missing
  arrays to `[]` (Go writes empty slices as `null`). Enum strings stay plain strings, because the
  server adds values and tells clients to tolerate unknown ones.
- Fields named for an ID kind (`session_id`, `block_ids`, `anchor_id`, …) use branded IDs from
  `rex-domain.ts`. The server's schema marks every ID nullable; a **required** ID decodes as the
  ID itself, and a `null` there is a contract violation (`RexInvalidResponse`).
- `$anchor` recursion (`view-layout-node`) becomes a named recursive codec; `anyOf` becomes a
  union; fixed-length arrays become tuples.
- Layouts are untyped in the server schema, so `rex-layout.ts` owns them (`rexLayout.terminal`,
  `.block`, `.horizontal`, `.vertical`) and encodes terminal options with the generated codec.

## Control connection (`RexControl`)

- `GET /api/control` over the Unix socket, subprotocol `rex.control.v1`. Unix sockets are dialed
  with `createConnection`, because `ws+unix:` URLs can't hold paths with spaces (macOS
  `Application Support`). Messages under 1 KiB are never compressed, so the hello and its
  reconnect token never are.
- Opens lazily on first use. Offers the revision the SDK was generated for and requests a minimum
  of 18. A `rex.control.v1` welcome at or above that minimum supplies `connection.apiRevision`.
  A different protocol fails with `RexHandshakeError`. An incompatible revision fails with
  `RexUnsupportedApiRevision`.
- Requests are correlated by `id`; responses may arrive in any order. Server error codes map to
  one tagged error each (`RexSessionNotFound`, `RexConflict`, …; unknown codes become
  `RexServerError` with the code). Requests larger than `max_message_bytes` fail locally with
  `RexMessageTooLarge`. A deadline (`RexRequestTimeout`) stops waiting; the server may still
  finish the request.
- Malformed control messages end the connection, because a lost response would otherwise hang
  until its deadline. Unknown message types are skipped.

### Reconnect decision

When the connection ends, in-flight requests fail with `RexConnectionLost` (they may have run)
and every event subscriber fails with `RexEventsLost`. **Nothing is replayed**: the docs say a
lost request may have run, so retrying could create a second window or type text twice. The next
request dials again and presents the last `reconnect_token`; if the server resumes the client
(`welcome.client.resumed`), attachments are kept, otherwise they are forgotten. This matches
herdr-sdk's rule of never resuming silently, without bricking the Layer after one drop.

## Attachments (`RexAttachments`)

Most session-scoped methods fail with `conflict` until the connection attaches. Before any
request whose payload names a `session_id` (except `session.attach`, `.attach_all`,
`.bootstrap`, `.detach`, `.list`, `.create`, `client.list`, and `client.perform`), the SDK calls
`session.attach` once per session per connection, sharing concurrent attaches and retrying after
a failed one. Explicit `sessions.attach`, `.detach`, `.attachAll`, and `.bootstrap` calls are
recorded so the automatic tracking stays consistent.

**Detach decision:** the SDK never detaches on its own. Attachments are cheap, belong to the
connection, and end with it; detaching when one caller finishes would break other callers that
share the connection. Callers who want to stop receiving a session's events call
`sessions.detach`.

## Events

- `RexControl.subscribe` gives each subscriber a bounded buffer (4096 events). A subscriber that
  falls behind, a skipped `seq`, or the end of the connection fails it with `RexEventsLost`
  instead of dropping events silently.
- `rex-events.ts` removes the `session_event` and `block_event` wrappers and tags events
  `ServerEvent`, `SessionEvent`, `TerminalEvent` (typed per event name), `BlockEvent` (other
  creators), or `UnknownEvent`.
- `events.stream` and `events.waitFor` subscribe **before** attaching, so nothing between
  attaching and reading is missed. `sessions.watchView` applies the documented rule for combining
  results with events: it re-reads `session.view` only for a `session_view_changed` with a newer
  revision. `terminals.waitForExit` checks `process.last_exit` after subscribing, so an exit
  between the two can't be missed.
- **`event_dropped` decision:** the server sends it in place of an event too large to send, under
  that event's own `seq`, so it is not a gap and does not fail subscribers. Helpers that keep
  state follow the documented remedy and read again: `watchView` re-reads the view for a drop
  naming its session, and `waitForExit` re-reads `process` for a drop naming its block or a
  dropped `block_closed` in its session (a vanished block fails with `RexBlockClosed`). Raw
  `events.stream` and `waitFor` pass it through as a typed `ServerEvent`.

## Data tickets

Data tickets never reach callers. `terminals.stream` asks for its own with `data.connect`, and
`sessions.bootstrap` strips `dataTickets` from both its input and its result, at the type level
and at runtime. File transfer methods that return tickets (`download_begin`, `upload_begin`) get
SDK operations only with the streams that consume them.

## Data connections

`rex-data-connection.ts` owns what every data connection shares: it turns a ticket into HELLO
bytes the moment it arrives (`rexDataHelloFromTicket`), opens `GET /api/data` uncompressed with a
subprotocol, sends the HELLO or RESUME, and waits for the WELCOME. `rex-data-codec.ts` owns the
HELLO, RESUME, WELCOME, and REJECT byte layouts. `rexDataCloseFailure` gives close codes one
meaning for both subprotocols: 1000 ends normally; 4000 fails with `RexBlockClosed`; other closes
fail with `RexDataStreamFailed`; a REJECT fails with `RexDataRejected` and its reason.

### Terminal streams (`rex-terminal-stream.ts`)

`terminals.stream` calls `data.connect` for a ticket and opens `rex.data.terminal.v1`. The parser
separates program output from
`ESC _ rex1;<nonce>;<json> ESC \` messages across chunk boundaries; sequences with another nonce
stay in the output. After a drop (1006 or keepalive timeout) the stream resumes with RESUME and
the exact count of bytes received, up to 3 times.

### Byte streams (`rex-bytes-stream.ts`)

Rex doesn't document `rex.data.bytes.v1`; `docs/research/rex-data-bytes-v1.md` records the
observed contract, and `rex-bytes-stream.ts` is the only module that encodes it:

- Messages carry raw bytes; an empty message is a half-close. `incoming` ends at the server's
  half-close; `end` sends ours.
- **Completion rule:** a stream succeeds only when the server closes with 1000 after a
  half-close. A 1000 without one fails with `RexTransferIncomplete`, so a cancelled download can
  never pass for a finished one.
- Closing the scope before the stream finishes closes it with 4001: a download or upload is
  cancelled, a tunnel connection is reset. Byte streams never resume.
- Writes wait for `ws.send`'s callback (Effect's socket writer doesn't wait), and reads pause the
  socket behind a bounded queue, so neither side buffers without limit.
- `maxBytes` (`RexTransferTooLarge`) and `stallTimeout` (`RexTransferStalled`) are opt-in per use:
  downloads default to a 30-second stall timeout and `readFile` to 64 MiB; tunnels set neither,
  because an idle TCP connection is normal.

**File transfers** (`rex-file-transfer.ts`, on `terminals`): `download` returns the file's
details and a byte stream, opening the data connection at once so the reservation (one of 16 per
terminal, held 60 seconds) can't expire unused. `readFile` collects it; `downloadToFile` writes a
temporary file beside the destination and renames it only when complete. `pasteFiles` is named
for its side effect: Rex types the uploaded files' paths into the terminal, so the name says so.
Files go one at a time in one batch, each with exactly its declared size.

**Tunnels** (`rex-tunnel-forward.ts`, on `tunnels`): `openStream` opens `conn:<uuid>` on a dial
tunnel; `connections` yields a listen tunnel's `connection_requested` events addressed to this
client. `forwardLocal` and `forwardRemote` create the block for their scope (closing it on
release) and bridge each TCP connection with half-open sockets: FIN maps to half-close both ways,
and any failure resets the other side. `forwardRemote` subscribes before creating its block so no
request is missed. A forward's `stopped` fails when its block closes or the control connection
ends; nothing re-adopts a tunnel, because its owner was the lost connection.

## Configuration

Endpoint order: `server` option, then `REX_SERVER`, then the personal-server default:

| Platform           | Default socket                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------ |
| macOS              | `~/Library/Application Support/rex/server.sock`                                                  |
| Linux              | `$XDG_RUNTIME_DIR/rex/server.sock`, else `${XDG_STATE_HOME:-~/.local/state}/rex/run/server.sock` |
| FreeBSD and others | `${XDG_STATE_HOME:-~/.local/state}/rex/run/server.sock`                                          |

Addresses may be socket paths, `unix://` URLs, `host:port`, or `http(s)://`/`ws(s)://` URLs.
Host labels from `rex hosts` are not resolved. `REX_SESSION`, `REX_BLOCK`, and `REX_CLIENT` are
exposed as `config.ambient` and never used implicitly.

## Verification

| Tool                              | What it proves                                                                                                                                                                                                                                                                                                                            |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/testing/rex-test-server.ts`  | A local server speaking the real control and data protocols. It validates every request against the method's `input_schema` and every scripted result against its `output_schema` with ajv; tests fail on any violation.                                                                                                                  |
| `src/rex-wire-schemas.test.ts`    | Every documented response example decodes, and every request example round-trips through the generated codecs.                                                                                                                                                                                                                            |
| `src/rex-contract-sweep.test.ts`  | Every SDK operation sends exactly the documented request and decodes the documented result. Its table is the parity ledger: it must name every server and block method (onboarding methods, and the terminal's `download_begin` and `upload_begin` until the SDK streams `rex.data.bytes.v1`, are reachable through `blocks.callMethod`). |
| `src/rex-control.test.ts`         | Handshake, revision checks, correlation, deadlines, close codes, message limits, reconnect token, event ordering, backlog, and gaps.                                                                                                                                                                                                      |
| `src/rex-sdk.test.ts`             | Attachment, input validation, events, `watchView`, `read` paging, `waitForExit`, data streams with resume, client request handlers, and configuration.                                                                                                                                                                                    |
| `src/rex-bytes-stream.test.ts`    | Downloads, pastes, and tunnels over `rex.data.bytes.v1`: the completion rule, end markers, 4001 aborts, limits, batching, 64 KiB messages, and both forwards over real TCP sockets.                                                                                                                                                       |
| `src/rex-terminal-stream.test.ts` | The stream parser at every split point, and the handshake byte layouts.                                                                                                                                                                                                                                                                   |
| `src/rex-live.test.ts`            | Opt-in (`vp run test:live`): every namespace against a real server, in a session the suite creates and destroys.                                                                                                                                                                                                                          |
| `vp run check:generated`          | The generated codecs match the snapshots.                                                                                                                                                                                                                                                                                                 |

Mutation checks during development confirmed the sweep and behavior suites fail when request
encoding, attachment sharing, or the resume byte count is broken.

## Known server behavior

- Since revision 18, blocks that `session.create` starts have no owner, because the caller can't
  be attached to a session that doesn't exist yet. `session.new_block` (and so
  `tunnels.createDial` and `.createListen`) makes the caller the owner only when it is attached,
  which the SDK's automatic attachment ensures. To own a new session's blocks, call
  `blocks.own` after creating it.
- Rex `0.0.1793047680` reports `exit_code` 0 for a terminal started with `shell: "none"` and
  `exit.on_completion: false`, even when the program exits non-zero. Commands run through the
  default shell report the real code.

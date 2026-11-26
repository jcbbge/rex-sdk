# Rex SDK: integration map

This Effect-native TypeScript SDK wraps the Rex server API behind a single `RexSdk` connection. Its namespace services include `server`, `sessions`, `windows`, `blocks`, `layers`, `terminals`, `tunnels`, `clients`, `events`, `targets`, `hosts` and `creators`. The installed fork targets Rex API revision 19 and requires revision 18 or newer. Rivet's bridge on hive is the SDK consumer (`~/rivet/app/src/bridge/rex.ts`); it holds the connection to hive's Rex server, not the M5 app's built-in server.

- Layer and connection architecture: `docs/architecture.md`, `src/rex-control.ts`, `src/rex-attachments.ts`, `src/rex-events.ts`.
- Wire contracts: `schema/`, `docs/research/rex-api-revision-19.md`, generated codecs in `src/generated/`.
- Requests and results: `src/rex-operation.ts`, `src/<namespace>-service.ts`, `src/rex-errors.ts`.
- Terminal I/O and data streams: `src/rex-data-connection.ts`, `src/rex-terminal-stream.ts`, `src/terminal-service.ts`, `src/rex-file-transfer.ts`.
- Build and tests are defined in `package.json` and `vite.config.ts`; the project uses `vp` for those scripts.

Session-scoped calls attach through `RexAttachments`. A lost response has an uncertain delivery outcome, so the bridge handles reconnect and receipts. The Rex app on the M5 is a client of hive's server and has a separate local server; see `~/rexconfig/docs/rex-rivet.md` on hive for the host map.

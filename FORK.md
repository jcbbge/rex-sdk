# Rex SDK fork

This checkout provides the local-path Rex SDK for Rivet. The fork lives on `origin/main`.
The `upstream` remote tracks Dillon's SDK.

## Fork changes

| Files                                                                                                                                                                            | Why                                                                                                                                                      |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/rex-config.ts`, `src/rex-control.ts`, `src/rex-errors.ts`                                                                                                                   | Offer the newest revision in the SDK and use the revision from the server's welcome when it meets the core minimum.                                      |
| `package.json`, `scripts/fetch-rex-api.ts`, `schema/rex-api.json`, `schema/rex-block-creators.json`, `docs/research/rex-api-revision-19.md`, `src/generated/rex-wire-schemas.ts` | Record Hive's live protocol snapshot and derive the wire codecs from it.                                                                                 |
| `src/block-service.ts`                                                                                                                                                           | Expose `focus_history.reverse` as `rex.blocks.reverseFocus` on the shared SDK connection.                                                                |
| `src/rex-control.test.ts`, `src/rex-contract-sweep.test.ts`, `src/rex-live.test.ts`                                                                                              | Verify negotiated revisions, the focus history contract, and reversal within a disposable live session.                                                  |
| `pi/fork-policy.ts`, `pi/index.ts`                                                                                                                                               | Filter the Pi registration and search catalog in one place. The policy matches known methods, focus and navigation names, and explicit focus parameters. |
| `pi/rex-tool-operations.ts`, `pi/rex-tool-search.ts`, `pi/test/rex-codemode.test.ts`, `pi/README.md`                                                                             | Record the focus history exclusion, keep examples and search help aligned, and verify that denied tools stay out of Pi.                                  |
| `pnpm-workspace.yaml`                                                                                                                                                            | Record pnpm's build decisions for the three transitive development packages whose install scripts are unused by the SDK build.                           |
| `README.md`, `AGENTS.md`, `docs/architecture.md`, `FORK.md`                                                                                                                      | Document the protocol, the local-path build, and how to fold upstream changes into the fork.                                                             |

## Fold in upstream changes

Start an integration branch from the current fork `main`. Fetch and review the upstream commits.

```sh
git fetch upstream
git log --oneline main..upstream/main
```

Use `git cherry-pick <commit>` to fold in one reviewed change at a time. Use
`git merge upstream/main` when the full set has been reviewed.

Refresh the snapshots from Hive and regenerate the wire codecs after each fold. Resolve any
conflicts in fetched snapshots and generated files by running these commands so their contents
come from Hive's server. Compare the new event reference with `schema/rex-events.json` when the
server changes its event schemas.

```sh
REX_SERVER=unix:///run/user/1000/rex/server.sock vp run fetch:rex-api
vp run generate
vp run check:generated
```

Review the snapshot diff and update the offered revision and snapshot metadata if they changed.
Review newly introduced Pi operations against `pi/fork-policy.ts`, then run the policy test and
the tests that cover the changes.

```sh
vp test run pi/test/rex-codemode.test.ts src/rex-control.test.ts src/rex-contract-sweep.test.ts src/rex-wire-schemas.test.ts
REX_SERVER=unix:///run/user/1000/rex/server.sock vp run test:live
pnpm run build
```

Publish the verified branch with `git push origin HEAD:main` when the push is a fast-forward.
Update and rebuild `~/rex-sdk` for local-path consumers.

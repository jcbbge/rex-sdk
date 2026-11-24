# `com.superlogical.terminal.blob_read` offsets (observed contract)

The protocol guide documents `blob_read` (`rex-api-revision-18.md`) but not what it does with an
`offset` that falls inside a character, or exactly how it measures `max_bytes`. This page records
what a probe observed. It is **evidence, not a server snapshot**: recheck it on every Rex upgrade.

**Probe**: `blob_read` on a `format` result (`trim`, `unwrap`) at every offset of a short output
with ASCII, `✓`, `€`, a real U+FFFD, `"`, `\`, `<`, `&`, `>`, and a tab, with `max_bytes` 0–8.
Rex `0.1.0-preview.21` (API 18, macOS), Unix socket, scratch session, 2026-11-24.

## What the guide says

- `offset`: "To read the next part, add the length in bytes of the data you received."
- `max_bytes`: "measured once it is encoded as a JSON string."
- `data`: "It never ends partway through a character."

## What Rex does

**An offset inside a character starts with one U+FFFD per byte left of that character.** The
reply's data is longer in UTF-8 than the bytes it read, so the guide's rule for the next offset
is wrong for such a read.

| Output bytes                      | Offset | `data` starts with | Bytes read | UTF-8 length of `data` |
| --------------------------------- | ------ | ------------------ | ---------- | ---------------------- |
| `✓` at 45–47, then `bb`           | 45     | `✓bb`              | 5          | 5                      |
|                                   | 46     | `��bb`             | 4          | 8                      |
|                                   | 47     | `�bb`              | 3          | 5                      |
| a real U+FFFD at 57–59, then `€`  | 57     | `�€`               | 6          | 6                      |
|                                   | 58     | `��€`              | 5          | 9                      |

A real U+FFFD in the output (offset 57) cannot be told from a cut byte (offset 47). The data alone
never says where a mid-character read began.

**`max_bytes` counts JSON-escaped characters, Go style:**

| Character                      | Counts as      |
| ------------------------------ | -------------- |
| `"`, `\`, newline              | 2              |
| `<`, `>`, `&`                  | 6 (`\u003c`)   |
| a cut byte shown as U+FFFD     | 1              |
| any other character            | its UTF-8 size |

A reply holds at least one character even when that character alone is over `max_bytes` (offset
45 with `max_bytes: 1` returns `✓`). Escape-heavy output therefore returns much less than
`max_bytes` of raw text: up to six times less. `format` with `max_bytes` cuts its first part the
same way.

Tabs come out of `format` as spaces, and other control characters are left out, so neither
appears in a result.

## What the SDK relies on

- Reads that start where the previous one ended (offset 0, or a previous offset plus the bytes of
  a read that itself started on a character) start on a character, so the guide's rule holds for
  them. `terminals.read` only reads this way.
- `terminals.readTail` may jump to an offset inside a character. It never computes another
  offset from such a read: it uses the jumped read only when that read reaches `eof`, and places
  every line by counting back from `total`. Otherwise it reads forward from the first part.
- `src/testing/rex-test-terminal.ts` reproduces both rules above, so tests exercise them.

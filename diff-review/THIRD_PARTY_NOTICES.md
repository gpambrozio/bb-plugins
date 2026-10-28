# Third-party notices

## diffity

Diff Review follows [diffity](https://github.com/nilbuild/diffity) (read at commit `ce9de40`,
2026-10-21, and `ebeb656` for the parts added in 0.3.0) and adapts parts of it:

- `server/prompt.ts` adapts the prompts `src-tauri/prompts/review-feedback.md` and
  `src-tauri/prompts/resolve.md`: their writing rules, rejected-edit rules and per-thread
  instructions, with `bb diff-review` commands in place of diffity's MCP tools.
- `server/run-prompts.ts` adapts `src-tauri/prompts/review.md` and `src-tauri/prompts/thread.md`, for
  AI reviews and answers to @reviewer; `shared/types.ts` keeps diffity's review focus names.
- `shared/mentions.ts` ports `src/lib/mentions.ts`: which mentions count, outside code (here
  `@reviewer` and `@agent`).
- `server/store.ts` follows the review tables of `src-tauri/src/core/store.rs` (sessions, threads with
  a file, side, line range, status, severity and anchor text, comments by the user or an agent), and
  the `__general__` / line 0 conventions for whole-diff and whole-file comments.
- `server/ignore.ts` reads the same ignore files as `src-tauri/src/core/diffignore.rs`.
- `server/run-prompts.ts` also adapts `src-tauri/prompts/summarize.md` and `src-tauri/prompts/explain.md`,
  for the Summarize and Explain runs.
- `app/find.ts` adapts `src/lib/find.ts` (find across the diff).
- `shared/suggestion.ts` adapts `src/features/suggestions/suggestion.ts`, and `app/suggestion-block.tsx`
  follows `suggestion-block.tsx` (suggested changes).
- `app/palette.ts` takes the colour-blind add/remove colours of `src/styles/app.css`.
- `host/git.ts` follows the ref grammar of `src-tauri/src/core/diff.rs` and the merged-branch fork point
  of `src-tauri/src/core/git.rs` (staged, unstaged and range views).

diffity is licensed under the MIT License:

```
MIT License

Copyright (c) 2026 Kamran Ahmed

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## ignore

The server bundle includes [`ignore`](https://github.com/kaelzhang/node-ignore) 7, from npm, for
gitignore-style matching. It is licensed under the MIT License; the full text is in the package's
`LICENSE-MIT`.

## @pierre/diffs

Diffs are drawn with [`@pierre/diffs`](https://www.npmjs.com/package/@pierre/diffs) (Apache-2.0). bb
provides it to plugins at run time; it is not part of this plugin's bundle.

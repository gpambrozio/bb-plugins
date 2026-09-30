# GitHub Board

A bb port of [`paseo-plugins/github-board`](https://github.com/gpambrozio/paseo-plugins/tree/main/github-board):
a board of GitHub work in four columns — Issues, Draft PRs, Open PRs and Discussions — covering what
you wrote, what is open on repositories you own, and what is assigned to you. Issues closed by a pull
request fold into its card, open pull requests show CI check pills and an out-of-date or conflicts
pill with an Update branch button, a detail panel shows the body and comments, and "Send to chat"
starts an agent thread on a card with an editable, per-column prompt.

**Status: being ported** ([issue #2](https://github.com/gpambrozio/bb-plugins/issues/2)). The GitHub
queries, their parsing, the image fetch and the prompt templates are carried over with their tests;
the board UI and the send flow are not built yet.

## Develop

```bash
npm install --include=dev
npm test
npx tsc --noEmit
bb plugin build
```

See [`AGENTS.md`](AGENTS.md) for the invariants this plugin keeps.

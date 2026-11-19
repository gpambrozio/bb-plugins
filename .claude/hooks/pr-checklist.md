Work through these items before stopping (Claude Code gets this list from a hook after `gh pr create`; Codex workers read it here). Say in the PR body which items do not apply and why.

A plugin has UI when its `package.json` `bb` manifest has `app`; its UI files are `app.tsx` and `app/**`.

1. Screenshots for a new plugin with UI:
    * README screenshots and a GIF come from `tools/shots/` (read `tools/shots/README.md` first): `npm run shots -- <plugin>`, driven by `<plugin>/shots/shots.mjs`, writes `<plugin>/docs/screenshots/`. A plugin with UI and no shot list gets one written.
    * Lead the README with the surface a user meets first.
2. UI changes: when a plugin's UI files change, re-run its shot list and update the README text that describes what changed. Commit the refreshed images.
3. Proof on the PR: a GIF showing the new feature or plugin working — the change itself, not just the README image.
    * Attach it with `gh pr comment <NUM> --attach '<file>.gif#<what it shows>' --body "🎥 <feature>: …"` (needs `gh` 2.99.0 or newer). The `#` suffix is the alt text: say what the GIF shows.
    * For an .mp4, attach it the same way but **do not reference it in the body**, and give it no `#` alt text. GitHub renders a player only from a bare attachment URL on its own line, which is what gh appends for an attachment the body never mentions; a markdown link to it comes out as a plain hyperlink.
4. Bug fix: add a test that fails without the fix and passes with it.
5. Version and changelog: bump the plugin's version and add a `## X.Y.Z` section to its `CHANGELOG.md` (CI enforces the bump). Write it for non-technical readers: what a user can observe, no RPC, file or function names.
6. Docs: when commands, settings or behavior changed, update the plugin's `README.md`, `AGENTS.md`, `skills/` and `PLUGIN_OVERVIEW.md`, and the repo's `AGENTS.md` for knowledge that is widely useful.
7. Privacy: open every new or changed image and GIF and check it shows no home paths, email addresses, tokens or unrelated thread text.
8. Marketplace: if the plugin is listed in the Community marketplace and its screenshots, description, overview, category or range changed, say in the PR body that the listing needs its own marketplace PR (see "Submitting to the BB Community marketplace" in `AGENTS.md`).

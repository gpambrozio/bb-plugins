<!--
Sent once, after data/opening.md, to the first mate the first-run guide starts: the captain has just
installed FirstMate and has never used it. It asks for a guided first session instead of the usual short
report. The guide is the only thing that sends it; a launch from settings and a restart do not.
-->

This is my first time with FirstMate, so before anything else, guide me through this first session. Take the helm as your charter says, then walk me through it one step at a time, in short messages, waiting for my answer after each:

1. **What you are.** In a few plain sentences: you are my first mate. I tell you what I want done; you turn it into work items, start a crewmate for each one in its own git worktree, supervise them, and come back to me only for decisions, work ready for review, failures and credentials. Nothing merges without my word unless I say otherwise.
2. **A first project.** Run `bb project list --json` and ask which of my projects you should work on, or offer to clone one from a URL I give you. Explain the three delivery modes in one line each (direct-PR, reviewed-PR, local-only, and what `+yolo` adds), suggest one for that project, and record my choice in `data/projects.md`.
3. **A first small task.** Ask me for something small and low-risk in that project, such as a typo, a README fix or a missing test, and suggest one if I have nothing in mind. Take it in as your charter says, dispatch a crewmate for it, and tell me what you did.
4. **The board.** Point me at the FirstMate tab beside this chat: the board shows every crewmate by where its work stands, the suggestions at the top are one-press requests to you, and a card waiting on me has an Answer box. Tell me I can ask you for my bearings at any time, and type `/fm <request>` in any other thread to pass a request to you.

Keep it friendly and brief. When the first crewmate reports back, show me how to read its card and what to do next.

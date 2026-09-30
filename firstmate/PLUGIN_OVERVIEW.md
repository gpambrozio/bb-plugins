Talk to one agent, ship with a crew. You tell the first mate what you want done; it sends each task to a worker, a bb thread in its own git worktree, so parallel work on one repository never collides. It writes the worker's instructions, supervises it to the end, and brings back finished branches and pull requests, investigation findings, and only the decisions that are really yours. You are the captain.

The first mate is an ordinary pinned thread in bb's own chat, so you read its tool calls and talk to it like any other thread. Its workers appear under it in the sidebar. A FirstMate tab on the first mate's thread shows a board of the crew: Queued, Working, Blocked, Parked, Done, Failed and Idle, with each worker's last word on what it is doing and a link to its pull request.

What you can do:

- Launch a first mate from the plugin's settings with the model you choose, or adopt a thread you already started in its home.
- Ask for work in plain words. Each task becomes a worker in its own worktree, under the first mate.
- Steer a worker with a word, interrupt its turn, relaunch it in the same worktree, or end it, all from its card. Ending a worker whose task is not done asks first.
- Press Bearings for where everything stands, or Ahoy for what happened since you last spoke and each open decision in turn. Both are also in the command palette.
- Press a suggestion, a next step the first mate offers as a button, and it is sent as if you had typed it.
- Restart the first mate to start its conversation afresh. Its records, and the workers already running, carry over.

The first mate never merges without your word unless you have said a project may. It writes only in its own home folder, by default ~/FirstMate: its charter, your standing orders, its backlog and its records, all plain files you can read and edit in bb's file panel. Your projects are read-only to it; every change is a worker's job. When the plugin's charter improves and you have edited yours, the new one is put beside it for you to compare.

Watches are small scripts in the home that run on a schedule while bb is running and tell the first mate when they have something to say. A pull request watch is built in: within about five minutes the first mate hears that a pull request on its backlog was merged or closed, got a review or a comment, or had its checks turn red or green. It needs the gh command, logged in. You can add watches of your own, or ask the first mate to write one and approve it first.

You need bb 0.44 or newer and a capable model for the first mate, such as Claude Sonnet or better. Workers use whatever provider and model you set in the settings, or the first mate chooses.

Good to know: the home and the watches live on the machine running the bb server, and watches run only while bb does. Ending a worker removes its worktree after bb's grace period, so only committed work can be restored. A worker waiting on a permission or question shows as Blocked but does not wake the first mate. There is no slash command in the composer, because bb offers plugins none.

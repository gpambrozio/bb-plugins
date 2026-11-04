Keep learning the code your agents write. After a commit, new files, a schema change or a merged
pull request, Learning Exercises offers a short exercise on that work, and runs it in a side thread
with a real answer card.

## What you get

- **An offer at the right moment.** When a turn ends after real work, one line appears above the
  composer naming what was done, with Start, Later and Not in this thread. Offers are decided from
  bb's own data (commits, the turn's file changes, pull request status), never by an AI, so they cost
  no tokens.
- **Nothing in your agents' context until you start.** The plugin ships no skill and adds no tools or
  instructions to your threads. Only a session you start receives the exercise instructions.
- **Sessions beside your work.** Start forks the thread, so the session's agent knows what was just
  built and your work thread is left as it was. Agents that cannot fork run it in the same thread.
- **A real pause.** Each question is a card: your answer, how sure you are from 1 to 5, Make it more
  specific, Skip and Pause. The agent's turn is over while the card is open, so it cannot hint.
  Your answers stay in the transcript in your own words.
- **The Learning tab.** In each thread's side panel: the offer or the session in progress, with
  Pause, Resume and Finish; start an exercise on the thread's last commit, its new files or a topic
  you type; and the project's paused and earlier sessions with your answers.
- **Caps that hold.** At most 3 offers a day, 2 hours apart, 2 sessions per thread; Later snoozes a
  thread; three Laters in a row keep only commit and pull request offers for a week. Offers you never
  see expire without counting.

## Where offers appear

Only in your own top-level threads: never in child threads, automations, other plugins' threads or
hidden workers. Turn offers off per thread from the thread menu, per project from the offer, or
everywhere in the settings.

## Requirements

- bb 0.48 or later.
- bb's bundled Git plugin on, to see commits; GitHub PR Status for pull request offers.
- Your answers are kept on this machine, in the plugin's own database, and can be deleted per session.

## Credits

The exercises, the pause rule and the learning science are adapted from Dr. Cat Hicks's Learning
Opportunities (https://github.com/DrCatHicks/learning-opportunities), CC BY 4.0. Not affiliated with
or endorsed by the author.

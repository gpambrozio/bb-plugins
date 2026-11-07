# Changelog

## 0.2.0

- Threads another plugin starts for you at the top level now get offers like your own. A thread
  started from a GitHub board card, for example, got no offer even when its first turn made a
  commit. Child threads still get none, whoever started them, and neither do the exercise
  sessions' own threads.
- A new setting, *Plugins whose threads get no offers*, lists the plugins whose threads never get
  offers. It starts with automations; add any other plugin's id, one per line.
- Only an offer you answer counts toward the limits now: offers per day, the hours between offers,
  and the count of busy turns before a streak offer. An offer you leave alone, even one you saw,
  expires and counts for nothing, so several offers in different threads can show at once until you
  answer one.

## 0.1.0

First release.

- After a commit, new source files, a schema change or a merged pull request in one of your threads,
  an offer appears above the composer: Start a 10–15 minute exercise on it, ask again Later, or turn
  offers off for the thread or the project. Offers are decided from bb's own data, not by an AI, and
  stop at 3 a day, 2 hours apart, 2 sessions per thread.
- Start opens the exercise in a side thread forked from your work, so the work thread is left as it
  was. Agents that cannot fork run it in the same thread.
- Each question is a card: write your answer, say how sure you are, or ask for a more specific
  question, skip it or pause. Your answers stay in the transcript in your own words.
- What you have typed in a card but not sent is kept as you go: leave the thread, reload or open it
  on another device and the card comes back as you left it, every field included. It is cleared once
  you answer or skip the question.
- When a question has several parts, the card can ask for the answer in a form: short and long
  text, code, a number, a slider, one or several choices, yes/no, a scale, putting items in order,
  matching pairs, a list or a table to fill in. A simple question keeps its single text box. Form
  answers appear part by part in the transcript and in the Learning tab, and survive a pause.
- The agent's feedback on each answer shows in the chat as a card with its verdict, above the last
  message of the turn that gave it, so bb's "Worked for" fold no longer hides it, the last answer's
  included. The next question's card shows it above the question too, and it is kept with each
  question, so it comes back after a reload and on other devices. Sessions already under way get
  their feedback back from the thread's own messages.
- Questions carry the code they ask about, such as an earlier version of a function, instead of
  pointing at a message "above"; a question with a code block left open is refused before you see it.
- The Learning tab in a thread's side panel starts an exercise on the thread's work, shows the
  session in progress with Pause, Resume and Finish and its questions and feedback so far, and lists
  the project's paused and earlier sessions with your answers and the feedback; each can be deleted.
- In sub-agent threads, which never get offers, the Learning tab is on the side panel's tab bar too,
  to start or resume an exercise there by hand.
- Files named in a question open in bb with a click, at the line or range the question points to; so
  do the files in your past answers and in an offer.
- No skill, tool or instruction from this plugin reaches an agent until you start a session.
- Exercises adapted from Dr. Cat Hicks's Learning Opportunities (CC BY 4.0); not affiliated.

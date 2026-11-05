# Changelog

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
- When a question has several parts, the card can ask for the answer in a form: short and long
  text, code, a number, a slider, one or several choices, yes/no, a scale, putting items in order,
  matching pairs, a list or a table to fill in. A simple question keeps its single text box. Form
  answers appear part by part in the transcript and in the Learning tab, and survive a pause.
- The Learning tab in a thread's side panel starts an exercise on the thread's work, shows the
  session in progress with Pause, Resume and Finish, and lists the project's paused and earlier
  sessions with your answers; each can be deleted.
- In sub-agent threads, which never get offers, the Learning tab is on the side panel's tab bar too,
  to start or resume an exercise there by hand.
- Files named in a question open in bb with a click, at the line or range the question points to; so
  do the files in your past answers and in an offer.
- No skill, tool or instruction from this plugin reaches an agent until you start a session.
- Exercises adapted from Dr. Cat Hicks's Learning Opportunities (CC BY 4.0); not affiliated.

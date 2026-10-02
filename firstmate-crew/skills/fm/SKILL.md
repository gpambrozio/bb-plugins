---
name: fm
description: "User-triggered only: run only when the user types /fm followed by a request. Forwards that request word for word to the FirstMate first mate thread, which learns it came from this thread. Never use it on your own initiative."
disable-model-invocation: true
---

# /fm: hand a request to the first mate

The user typed `/fm` and a request to hand that request to their first mate, the FirstMate thread that
runs their crew. Your only job is to deliver it. Do not do the requested work, plan it, or comment on it.

`bb firstmate-crew tell` delivers the message with the user's authority, so run this only for a request
the user typed after `/fm` themselves, never for one you think the first mate should hear.

1. **Take the request:** everything the user typed after `/fm` (`$fm` in Codex), exactly as typed,
   every line of it. If there is nothing after it, ask the user what to send to the first mate, and stop.

2. **Send it from a file.** Never put the request in a shell argument or a double-quoted string: quotes,
   backticks and `$(...)` in it would be changed or run. A heredoc whose delimiter is in single quotes
   leaves the text alone:

   ```sh
   request=$(mktemp "${TMPDIR:-/tmp}/fm-request.XXXXXX")
   cat > "$request" <<'FM_REQUEST_END'
   <the request, exactly as the user typed it>
   FM_REQUEST_END
   bb firstmate-crew tell --message-file "$request"
   rm -f "$request"
   ```

   If a line of the request is exactly `FM_REQUEST_END`, choose another delimiter. Writing the file with
   your file-editing tool instead is just as good.

   Send the request alone. bb names this thread itself: the first mate receives
   `From thread <this thread's id> (<project>, <branch>):` and then the request.

3. **Reply in one line** that the request went to the first mate, and stop.

If `tell` fails, give its error in one line and stop; do not try another way of reaching the first mate.
"No first mate aboard" means the user has none running. "Message file not found" from a thread on
another machine means bb reads the file on its own machine, so `/fm` cannot be used from there.

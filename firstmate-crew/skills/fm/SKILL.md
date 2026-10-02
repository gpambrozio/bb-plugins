---
name: fm
description: "User-triggered only: run only when the user types /fm followed by a request. Forwards that request word for word to the FirstMate first mate thread, which learns it came from this thread. Never use it on your own initiative."
disable-model-invocation: true
---

# /fm: hand a request to the first mate

The user typed `/fm` and a request to hand that request to their first mate, the FirstMate thread that
runs their crew. Your only job is to deliver it. Do not do the requested work, plan it, or comment on it.

`bb firstmate-crew tell` speaks for the user, so run this only for a request
the user typed after `/fm` themselves, never for one you think the first mate should hear.

1. **Take the request:** everything the user typed after `/fm` (`$fm` in Codex), exactly as typed,
   every line of it. If there is nothing after it, ask the user what to send to the first mate, and stop.

2. **Send it as base64 through stdin.** Never put the request in a shell argument or a double-quoted
   string: quotes, backticks and `$(...)` in it would be changed or run. A heredoc whose delimiter is in
   single quotes leaves the text alone, and base64 makes it the one line bb's `--message-base64-stdin`
   reads:

   ```sh
   base64 <<'FM_REQUEST_END' | tr -d '\n' | bb firstmate-crew tell --message-base64-stdin
   <the request, exactly as the user typed it>
   FM_REQUEST_END
   ```

   Run exactly that one pipeline; its exit status is `tell`'s. If a line of the request is exactly
   `FM_REQUEST_END`, choose another delimiter. Requests up to 12 KiB fit.

   Send the request alone. `tell` opens it with a line of its own saying it was relayed from this
   thread, with the thread's project and branch.

3. **Reply in one line** that the request went to the first mate, and stop.

If the pipeline fails, give `tell`'s error in one line and stop; do not try another way of reaching the
first mate. "No first mate aboard" means the user has none running. A request that is too long has to
be shortened by the user.

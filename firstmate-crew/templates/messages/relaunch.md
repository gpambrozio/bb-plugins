<!-- Sent to the first mate when the captain presses Relaunch on a crewmate's card. {{title}} is the crewmate's thread title, {{task}} the task it was started with (empty when it has none), {{threadId}} its thread id, {{environmentId}} the environment it works in (empty when bb has none for it), {{note}} what the captain typed. -->

ahoy! Relaunch the worker "{{title}}" (task {{task}}, thread {{threadId}}): start a fresh worker for its task with `--environment {{environmentId}}`, so it carries on in the same local copy, as step 4 of your stuck-crewmate ladder says. If the task or the environment is missing here, find it from the backlog's (thread: {{threadId}}) and `bb thread show {{threadId}}`.
The captain's note for the new worker: {{note}}

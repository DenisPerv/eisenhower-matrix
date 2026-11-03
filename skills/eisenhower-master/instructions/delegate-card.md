# Delegate card: hand a task to the person

When work cannot go on without the person (D10, D18), the task itself becomes the card: it moves to Delegate (quadrant C) in its own list, the person as assignee. In v1 every Delegate item goes to a person (D16).

1. Claim the task (or keep your claim), then `claim.js delegate --id <id> --holder <your session name> --reason "<one plain sentence>" --session "<your session name>"`. It moves the task to C, drops the lease and assigns the owner.
2. Append the card to the description, exactly in this shape (the session and the question in bold):

   ```
   ## Delegate · <yyyy-mm-dd hh:mm>
   Session: **<your session name> · <session id>**
   Continue it: `claude --resume <session id>` in a terminal opened in the repository the session ran in
   Context: <two or three sentences: what was done, what the choice depends on>
   Question: **<one question the person can answer>**
   Options: A) … B) …
   Comes back to: <Plan | Do> (D6)
   ```
   Your session name and id are in the environment (`EIS_SPAWN_NAME`, `EIS_SESSION_ID`, set by `spawn.js`); the master, which runs in the app, uses its own id from `get_session self`.
3. Set the tag `needs-person`. Screen the context for secrets, tokens and ID numbers before writing (G38; the database refuses ID and card numbers).
4. The same blocker twice for the same task: add `Repeat: <first date>` to the card instead of a new card (G19).
5. Never ask a question card. Write the card and go on with the work that does not depend on it.

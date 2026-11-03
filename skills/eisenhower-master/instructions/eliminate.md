# Eliminate session: propose drops

Agents only propose; the person decides (D17). Once per list per run. You run in auto and are not a master.

1. Take the suspects from the latest scan (`scan.js` lists each with a plain-language reason: an older duplicate, the same work already done, work made redundant by later changes).
2. For each suspect, check the reason yourself against the board and the repo: find the duplicate or the work that made it redundant and name it (`<list>#<num>`, a commit, a file). A suspect you cannot back with evidence is dropped.
3. A proposal the person kept earlier for the same reason (`ai.keep` on the item, or a description line `Kept by <person>: <reason>`) is not raised again until the task changes (G33).
4. Propose: claim, append to the description `Eliminate proposed · <your session name> · <date>: <one or two plain sentences why, with the evidence>`, tag `eliminate-proposed`, move to quadrant D and give it to the owner (`node cli/tasks.mjs update '<ref>' --q D --owner <the owner's handle>`), release. A proposal without a reason sentence is never written (D17a).
5. Never cancel or delete: the person cancels. Report the proposals with their refs and reasons.

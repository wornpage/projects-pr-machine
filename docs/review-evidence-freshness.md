# Mutable review evidence: revalidation and limits

PR #35's independent review identified a gap: head/base identity can remain stable
while an approval is dismissed, a new changes request is submitted, or a resolved
thread is reopened. Rechecking only the revision tuple did not catch that drift.

The collector now performs **two complete bounded observations**, with PR identity
checks before, between and after them. Each observation separately validates every
review and thread page, applies the same reviewer policy, and rejects outstanding
changes requests, missing approvals and unresolved threads. The canonical digests
of both observations must agree. Added/removed decisions or threads also refuse
with `review_state_changed`, even when either observation alone would pass. Mere
ordering differences do not count as semantic drift. There is no retry that adopts
new authority. Pagination restarts at page one / a null cursor for the second pass.

The existing per-request timeout and response-size bounds remain unchanged. At
most ten review pages and ten thread pages are read **per observation**, plus three
identity reads (43 requests maximum). Incomplete or failed revalidation refuses.
Pending review drafts and review prose do not constitute submitted decisions;
comment bodies do not grant authorization. The receipt format remains unchanged.

## What this proves, and what it does not

The receipt records agreement between two complete observed states. It does **not**
prove an atomic GitHub snapshot, uninterrupted approval, or future authorization.
Changes during the final pass or after the last relevant read can still occur;
there is no shared transaction between the reader, GitHub and a service database.
Do not cache `status: validated` as permission to merge/deploy. Use the authoritative
provider's normal protected mutation path, current policy and exact-head checks at
the actual effect. No protection bypass or durable merge permission is introduced.
A stronger cross-service consistency guarantee requires a different provider /
transaction protocol; repeated reads alone cannot supply it.

The deterministic regression suite changes authorization state after the original
pass with an unchanged PR tuple. Against the previous collector it reports one
pass and eleven failures; the corrected collector passes all twelve, including
complete re-pagination, redaction and ordering controls. Existing reader/policy
cases remain covered by `test/github-review-evidence.test.mjs`.

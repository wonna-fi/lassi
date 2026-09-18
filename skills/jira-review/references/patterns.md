# Patterns and counterexamples

These are tests for a suspected problem, not requirements to add to every issue.

| Pattern | Report when | Suppress when |
|---|---|---|
| Conflicting rules | Same actor/state must both retain and delete the same data | The rules apply before and after an explicit state transition |
| Numeric drift | Description says 20 items per page, AC says 50 for the same list | 50 is sample data, or the Epic explicitly permits a child override |
| Undefined boundary | "Large uploads" selects different workflows without a size boundary | A linked, applicable definition supplies the boundary |
| Ambiguous scope | "All users" can include guests or mean signed-in members, changing access | A scoped definition in the issue/Epic defines "users" |
| Missing outcome | A timeout/retry is in scope but two plausible results affect data correctness | The concern is an unrelated hypothetical or inherited behavior is explicit |
| UI discrepancy | An approved target shows a required field optional, for the same state | It is a screenshot of the bug being fixed or an explicitly superseded mockup |
| Epic conflict | A child requires an action the Epic explicitly excludes for that release | The Epic contains additional work assigned to another child |
| Terminology drift | "Owner" and "requester" change who receives a notification | They are declared synonyms in applicable context |
| Unsettled authority | Two candidate designs differ and no source selects one | A scoped decision identifies the accepted attachment by ID |
| Evidence gap | An image is inaccessible or the Epic fetch fails | Never convert this into a requirements defect; report a coverage limit |

## A useful internal finding

Description D2: "Keep completed exports for 14 days." AC3: "Remove completed exports after 7 days."

Useful: "D2 and AC3 give different retention periods for completed exports. A day-10 export must
both exist and be gone. Should retention be 7 or 14 days?"

Unhelpful: "Clarify data retention and improve the acceptance criteria."

## A useful ambiguity

AC2: "Notify inactive members." No definition of inactive appears in the available issue or Epic.

Useful: "Does inactive mean an administratively disabled account or no login during a period?
Those choices send notifications to different people. If login-based, what period applies?"

Unhelpful: "Please provide the full notification architecture and all edge cases."

## A visual comparison

AC4 says Save is disabled when the name is empty. The approved target image, attachment 401,
`form.png`, shows an empty Name field and a visibly active Save button at the bottom right.

Useful: cite AC4 and that region, describe the apparent enabled state, and ask whether the target
design or AC should change. If the image is only a styling mockup, qualify the concern instead of
claiming the button's real behavior is proven. Do not infer a network request from button styling.

Unhelpful: "The screenshot proves the backend accepts invalid names."

## A child that is consistent

Epic E2 requires audit logging for all exports. The child only adds the export button and explicitly
assigns audit logging to a sibling. No contradiction. Likewise, a child can use an error format
defined in its Epic without repeating it. Cite inheritance if it explains an apparent omission.

## A resolved concern versus documentation drift

A comment explicitly replaces mockup attachment 402 with 403 and explains that both retain the
same filename. Compare 403 with the requirements. Do not report 402 as the active target.

If the same comment changes a limit to 30 but the still-current AC says 90, report the stale AC
as documentation drift. The question is whether to update that AC, not which limit to invent.
If both the current AC and accepted mockup already say 30, there is no active finding.

## No finding is a valid result

"No material ambiguities or contradictions found in the inspected evidence. Reviewed the issue
and all 3 comments, both attached images, and the linked Epic. The older mockup is explicitly
superseded by comment 701."

If the Epic was inaccessible, replace the last claim with that limitation. Do not treat missing
access as evidence that the Epic agrees, and do not call an incomplete review a complete pass.

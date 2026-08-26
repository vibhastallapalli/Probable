# Probable placement policy

`placement-policy.sleec` is the checked policy for Probable's placement
fallback. It is a design-time artifact, not a runtime dependency: JavaScript
still analyzes the clip and implements the behavior, while LEGOS-SLEEC checks
the policy for contradictory rules and reachable bad outcomes.

## What the formal state represents

- `PlacementDecision` represents the result of the placement pipeline.
- `placementResolved` says whether repeated evidence produced a supported
  row and a center-versus-side class.
- `recoveryAttempted` separates the initial three-frame check from the one
  bounded visual recovery.
- The four reason measures represent ball, goal, shot-moment, and placement
  disagreement evidence. Several may be true together.
- `technicalFailure` and `technicalRetryExhausted` keep model/system failures
  separate from clip-quality feedback.
- `MatchSettlementRequested` and `matchHasUnresolvedClip` represent the final
  payout guard.

## Transformation-stable horizontal placement

Left and right carry identical placement points, and testing the real clips
showed that a model can flip its directional word under mirroring while still
assigning the wrong semantic side to the original clip. Runtime evidence
therefore asks only the scoring-relevant question: is the finish in the center
third or either side third? A horizontal mirror must preserve that class along
with ball visibility, the full goal, the ball/goal relationship, arrival
moment, row, and ground proximity. If any invariant changes, placement remains
unresolved and the existing SLEEC fallback rules block scoring and settlement.

The formal policy does not need another branch for this representation:
`placementResolved` is true only after center-versus-side itself has the
required invariant evidence. The application never assigns or displays an
exact left/right claim.

## Arrival versus aftermath

The ball's position after a goal is not necessarily its entry position: a
lifted finish can fall, bounce, or settle near the turf. Each observation now
classifies the sampled moment as `arrival`, `aftermath`, or `unclear`. Only an
`arrival` observation may vote on row and center-versus-side. An initial set
containing aftermath evidence triggers the same one bounded recovery attempt
on earlier unused moments; if two supported arrival observations still cannot
be found, placement stays unresolved.

## Ground-reference consistency

Each placement observation now commits to the ball's proximity to the goal's
ground level before choosing a row. When the same usable observation says the
ball is `near_ground` but labels it `mid` or `top`, JavaScript retains the raw
answer for the evidence trace and corrects the contradictory row to `bottom`.
It does not use this rule to promote an unclear observation, recover a missing
ball or goal, or bypass the repeated-frame and mirror checks.

The final placement sentence is composed from the verified policy result, so
discarded raw wording cannot reintroduce the wrong row. Placement also remains
separate from skill, difficulty, and aesthetic judging; an incorrect placement
observation cannot be repeated across all four score explanations.

The later observation pass is grammar-constrained to closed categories such
as distance, speed, contact type, pressure, and ball motion. Extra prose and
unsupported details are discarded before judging, and placement outcome is
not passed into the other three criteria.

This is another implementation-level refinement inside the formal
`placementResolved` state. The SLEEC file remains unchanged because no new
runtime outcome is introduced: the row either has consistent supporting
evidence and may resolve, or the existing unresolved fallback applies.

The implementation corresponding to those states lives in:

- `src/main/placement-policy.js` — evidence thresholds, recovery selection,
  and user-facing feedback.
- `src/main/scoring.js` — Qwen calls and pipeline orchestration.
- `src/main/settlement.js` — unresolved-match payout guard.
- `src/renderer/App.jsx` — clip-specific and system-specific reports.

## Checked result

The official LEGOS-SLEEC command-line checker produced these results:

- `placement-policy-draft-conflict.sleec`: conflict detected between the old
  unresolved-placement fallback and the evidence-integrity rule.
- `placement-policy.sleec` conflict analysis: all 19 rules reported
  `Not Conflicting`.
- `placement-policy.sleec` concern analysis: all 13 harmful-outcome concerns
  reported `concern not raised`.

In plain language, the corrected formal model contains no detected rule
conflicts, and it makes the listed bad outcomes unreachable. Those outcomes
include assigning placement after failed recovery, continuing unsupported
scoring, retrying forever, blaming the clip for a technical failure, omitting
reason-specific guidance, and settling a match with an unresolved clip.

From the LEGOS-SLEEC repository directory, with its Python dependencies
installed, the checks are:

```bash
python3 commandline_tool.py /path/to/Probable/sleec/placement-policy-draft-conflict.sleec c
python3 commandline_tool.py /path/to/Probable/sleec/placement-policy.sleec c
python3 commandline_tool.py /path/to/Probable/sleec/placement-policy.sleec con
```

Run `npm test` in Probable to check that the JavaScript implementation follows
the same branches.

## Boundary of the claim

LEGOS-SLEEC checks the consistency and consequences of the written policy. It
does not inspect video, validate Qwen's visual observations, prove that the
JavaScript is identical to the SLEEC model, or run while a user scores a clip.
Those implementation details are covered separately by the automated tests
and by clip-level testing in the app.

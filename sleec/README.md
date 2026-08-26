# Probable placement policy

`placement-policy.sleec` is the checked policy for Probable's placement
fallback. It is a design-time artifact, not a runtime dependency: JavaScript
still analyzes the clip and implements the behavior, while LEGOS-SLEEC checks
the policy for contradictory rules and reachable bad outcomes.

## What the formal state represents

- `PlacementDecision` represents the result of the placement pipeline.
- `placementResolved` says whether repeated evidence produced a supported
  row and either an exact column or a direction-neutral side class.
- `recoveryAttempted` separates the initial three-frame check from the one
  bounded visual recovery.
- The four reason measures represent ball, goal, shot-moment, and placement
  disagreement evidence. Several may be true together.
- `technicalFailure` and `technicalRetryExhausted` keep model/system failures
  separate from clip-quality feedback.
- `MatchSettlementRequested` and `matchHasUnresolvedClip` represent the final
  payout guard.

## Mirror degradation without invented placement

Left and right carry identical placement points. When a horizontal mirror
preserves ball visibility, the full goal, the ball/goal relationship, the row,
and the fact that the finish is off-centre—but Qwen fails to reverse the exact
left/right word—the implementation discards only that unsupported direction.
It assigns an internal `side` class with the same score and tells the user that
left/right was not verified. If any invariant fact changes, or the mirrored
answer changes between side and centre, placement remains unresolved and the
existing SLEEC fallback rules still block scoring and settlement.

The formal policy does not need another branch for this representation:
`placementResolved` is true only after the direction-neutral class itself has
the required invariant evidence. No exact left/right claim is assigned.

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

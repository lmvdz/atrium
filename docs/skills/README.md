# Working method

Copies of the orchestration skills this repository was built with, kept here so
they travel with a clone and can be read by any model or person picking it up.

**These are working copies.** The originals live in the maintainer's Claude Code
skills directory and may have moved on. Where they disagree, prefer whatever the
tracker's map (#1) says the campaign is using.

## `campaign.md`

Loose idea → decision graph on a tracker → gauntlet-verified product. The parts
worth reading even if you are only fixing one thing:

- **Blind means blind.** Critics get fresh context, never the builder's notes or
  each other's findings, and never write to the tracker. If they posted mid-review
  the second critic would correlate with the first.
- **Adjudicate before acting.** A finding is a hypothesis — verify the top ones
  against source yourself. And a *severity rating* is a hypothesis too, including
  a rating of "not severe".
- **Name the mutation, not the assertion.** Every test states the source change it
  now catches. A fix round that rewrites a bad test routinely deletes the coverage
  the bad test pretended to have, invisibly in the diff.
- **The destination gate.** Before dispatching any round, name which destination
  ticket it unblocks. "None directly" is legal and must be stated. The count of
  consecutive rounds answering "none" is the only drift signal this process
  produces — and the campaign that wrote this rule spent a day drifting because
  nothing counted it.
- **Merge continuously.** Lanes that diverge for days compose in ways nothing local
  can see. This repo's own example: two branches, each internally consistent and
  each passing a blind review, produced a dead product path with **zero git
  conflict markers**, caught by one red integration test out of 135.

## Model routing, as used here

Route by the *shape* of the task, not by a smartness ladder.

| shape | model |
|---|---|
| Orchestration, arbitration, adjudicating a gauntlet | a strong reasoning model; this campaign used Claude Opus |
| Iterative in-repo work that must run suites and react to failures | a native subagent with repo access |
| A self-contained spec producing an isolated diff | `codex exec` with GPT-5.6 |
| Read-only breadth over a large corpus — "find every call site of X" | a large-context model in one pass, no chunking |
| Anything user-facing: UI, copy, API design | a model with taste, independent of how well-specified it is |

Blind critics should draw from **different lineages** than the builder wherever
possible, so verdicts decorrelate. Measured on this repo: reviewing one change,
two different foreign-lineage reviewers each found a ship-blocking defect the
other missed, and each refuted a false claim from the other.

Do not hand a long-horizon, multi-file autonomous implementation to a model
selected for breadth or for terminal work; sweep and review with it instead.

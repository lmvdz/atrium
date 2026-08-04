# Phase 3 dogfood: Atrium runs Atrium

Status: preregistered; no observations recorded yet

Authority: `init.md` Phase 3 and the Phase 3 entry in `docs/TRACKER.md`

Expires: when the protocol reaches its stop rule or a finding proves the protocol cannot measure what it claims

## Question

During an ordinary, long-running Atrium development campaign, does Atrium preserve shared state well enough to reduce reorientation and coordination failures without creating comparable correction or organization work?

## Context

The first project is the Atrium campaign itself. Its existing workflow maps directly onto the product: decisions and commitments become accepted state, open work becomes Needs-you, build and gauntlet receipts retain provenance, and conversation remains the authored record.

Phase 2 established only a calibration result: on one fixed 111-message replay and the same browser-only question set, Atrium was 4.14× faster than a raw chronological thread and produced the more precise answer. That result is not a Phase 3 success threshold. It does not measure repeated questions, forgotten work, interpretation errors, attention usefulness, or the burden of keeping a live project organized.

## Destination

A bounded set of real-use receipts from which we can decide one of three things:

1. proceed to the narrow Phase 4 agent because the collaboration surface is already useful;
2. tune a measured compression or interpretation failure before Phase 4; or
3. extend observation because the run was incomplete or inconclusive.

The destination is evidence and a decision, not a new feature count.

## Scope boundary

During the observation window:

- Use the shipped Conversation, Current state, and Needs-you surfaces for actual Atrium work.
- Record friction as evidence; do not immediately turn every friction point into code.
- Fix only data loss, security/auth failure, inability to continue the trial, or a defect that corrupts the measurements. Such an intervention is named in the receipt.
- Do not add agents, execution runtimes, Iroh, federated storage, voice/video, compression tuning, or new semantic object types.
- Do not enable a paid interpretation model merely to start the trial. If one is enabled later, that change starts a separately labelled measurement stratum.

## Acceptance test

- At least five qualifying return sessions exist; otherwise the outcome is explicitly `incomplete`.
- Every included session passes `pnpm dogfood:validate -- <receipt...>`.
- The final summary reports every metric named in `init.md`, its denominator, interventions, and missing data.
- Each non-zero failure points to authored messages, accepted objects, attention items, or a contemporaneous observer note. No reconstructed quotation is accepted as evidence.
- The final decision names which observation supports it and remains reopenable.

## Verification gate

```sh
pnpm dogfood:validate -- --self-test
pnpm dogfood:validate -- plans/phase3-dogfood/receipt.example.json
```

The self-test names the mutations it catches. The example proves the documented shape is accepted, but is marked as a template and cannot be counted as an observation.

## Gauntlet

Before the first real observation, a fresh critic checks whether the protocol can be gamed into a positive result and whether each metric can be recorded from ordinary use. After the stop rule, a fresh critic receives only the preregistration and receipts, recomputes the summary, and gives both a measurement verdict and a product verdict.

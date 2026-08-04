# Dogfood protocol v1

## Observation window

Start with the first non-template receipt. Stop at the earlier of:

- ten qualifying return sessions; or
- fourteen calendar days after the first receipt.

Fewer than five qualifying sessions is `incomplete`, not a pass or failure. A qualifying return follows at least four hours away while the project changed. Ordinary overnight returns count; manufactured waiting does not.

The unit is a return session, not a message. One person opening the project once produces at most one receipt, even if they revisit several rooms.

## Fixed reorientation task

Before doing new work, answer from Atrium:

1. What are the current decisions?
2. What questions remain open?
3. Who owes what?
4. What is the current objective?

Start the timer before opening the room and stop it when all four answers are recorded. The receipt stores whether each was answered and evidence references, not reconstructed speech. Tool capabilities must be listed; changing them creates a new measurement stratum and cannot silently join the old one.

## Metrics

All counts cover the interval from the previous qualifying receipt to the current one unless stated otherwise.

| Metric | Operational definition |
| --- | --- |
| Reorientation time | Wall-clock milliseconds for the fixed task. Report median and every value. |
| Repeated questions | Authored questions whose answer already existed in accepted state before the question, divided by authored questions reviewed. Similar wording alone is not enough. |
| Forgotten commitments | Accepted commitments that passed their due condition without completion, explicit renegotiation, or acknowledgement before the return, divided by due commitments reviewed. |
| Missed decisions | Accepted decisions that the returning participant's fixed answer omitted or contradicted when relevant to current work, divided by relevant decisions reviewed. |
| Incorrect interpretations | Machine-drafted semantic objects judged materially unsupported or wrong, divided by all drafts reviewed. Unreviewed drafts are reported, never treated as correct. |
| Useful attention | Attention items judged to require or correctly focus human action, divided by all items reviewed. Unreviewed items are reported. |
| Manual organization | Wall-clock milliseconds spent correcting, accepting, linking, or otherwise maintaining shared state outside ordinary authored conversation. |

Counts are observations, not blame. Zero is valid only when the receipt names the evidence surface checked.
Manual-organization time is reported beside total active work-session time; it is not divided by absence time or wall-clock time away.

## Recording discipline

- Record a receipt immediately after reorientation and before fixing discovered friction.
- Evidence references are stable identifiers or file/issue links. Quote only exact authored text when a quote is necessary.
- Record every intervention that changes the product, data, model, prompt, tools, or protocol during the window.
- Do not combine receipts with different `stratum` values into one performance number.
- A receipt with any unanswered fixed question remains an observation but makes that stratum inconclusive.
- The validator checks shape, arithmetic, time bounds, the fixed question set, and evidence presence. It cannot determine whether a human judgment is true; final review must inspect the referenced facts.

## Decision rule

The protocol does not preregister a vanity threshold. At the stop rule, judge the whole profile:

- Phase 4 may proceed only if at least five sessions qualify, all seven metrics are present, and no unresolved data-loss or provenance defect makes the shared state untrustworthy.
- A recurrent failure class observed in at least two independent sessions becomes a bounded tuning ticket before Phase 4.
- A one-off friction point remains an observation unless its severity independently blocks safe use.
- Missing denominators, changed tools, or unreviewed semantic/attention populations make the affected claim inconclusive.

This rule is reopenable if the first receipts show that a definition cannot be applied without guessing.

## Commands

```sh
# Validate the instrument itself.
pnpm dogfood:validate -- --self-test

# Validate and summarize one or more real receipts.
pnpm dogfood:validate -- path/to/receipt-001.json path/to/receipt-002.json
```

Real receipts may contain project-sensitive references and need not be committed. The final aggregate receipt must say where the underlying evidence was retained and what a reviewer could not access.

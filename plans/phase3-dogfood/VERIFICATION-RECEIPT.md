# Phase 3 protocol verification receipt

Date: 2026-08-03

Branch: `phase3/dogfood-protocol`

Base: `5cd9efe`

## Instrument verification

- `pnpm dogfood:validate -- --self-test`: **15/15 named mutations caught**.
- `pnpm dogfood:validate -- plans/phase3-dogfood/receipt.example.json`: accepted the documented shape and reported zero qualifying sessions, excluding the template.
- Focused Biome check over `package.json`, `plans/phase3-dogfood`, and the validator: pass.
- `git diff --check`: pass.

The mutation set includes shortened and overlapping absences, changed fixed questions, impossible failure/population arithmetic, a non-boolean template marker, missing evidence, template inclusion, duplicate run and opening identities, fast non-answers, unreviewed interpretations, combined strata, normalized template placeholders, and extension beyond the global ten-session stop.

## Blind protocol review

A read-only fresh-context critic initially failed the protocol because cloned sessions could qualify, three failure metrics lacked reviewed populations, non-answers could appear fast, unreviewed work did not force an inconclusive result, and strata were numerically combined.

After those repairs, the critic found that overlapping claimed absences could still manufacture returns and that new strata reset the campaign stop rule. The final version requires each absence to end at the return, prevents a same-observer absence from overlapping the preceding receipt, keeps one global ten-session/fourteen-day window, summarizes strata separately, and rejects normalized template markers in real receipts.

Final frozen-tree critic verdict: **PASS**. It reproduced the former attacks, confirmed they now reject, ran the 15/15 self-test, and found no remaining High or Critical protocol/validator mismatch. It left truthfulness of evidence references and deliberately manufactured waiting to final human review, matching the protocol's stated boundary.

## Repository gate

The service-free root unit run reached **3,030/3,031**. Its one refusal was the auth lane's fail-closed repository scanner reporting two local macOS metadata files:

- `apps/.DS_Store`
- `packages/.DS_Store`

No product assertion failed. With those exact files temporarily moved to a generated temporary directory and restored by a shell trap, the affected `@atrium/auth` gate passed **409/409**. The files were restored; the scanner was not weakened and the metadata was not deleted. Heavy integration and browser suites were not rerun because this lane changes no application, database, or runtime behavior.

## Runtime cleanup

This lane started no application server, database, browser, or container. The final Docker enumeration contained no containers. The only long-running processes observed belonged to a different repository and were deliberately left alone.

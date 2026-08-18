# Covenant demo — RUNBOOK (#212)

A thin, DRIVABLE covenant slice: a human certifies a text span (✓), an agent-peer
edits the shared document, and the ✓ visibly de-certifies to `~` in front of the
human — then re-validates on an exact revert. Two panes are two real CRDT replicas
joined to ONE in-process `InMemoryConversationHub`, so what you drive in one pane
converges to the other; that is the thin-slice convergence proof.

> **This is NOT a ledger act.** Certify here writes a **local demo anchor** for the
> client resolver only — it does not call the gated `certifyObjectSpanAction` /
> `certify-anchor.ts` (reserved). The glyph authority is the fail-closed **client
> resolver** (`client-covenant.ts`), which REUSES `@atrium/core`'s `resolveCovenant`
> / `certifyAnchor` and the production `CovenantDocReaderProd` over the live client
> `ConversationDoc` + a client-side anchor store. No Electric, no Postgres, no auth.

## Run it

```bash
pnpm --filter web dev              # from repo root (needs packages built once:
                                   #   pnpm -r --filter './packages/*' build)
# open:
http://localhost:3000/prototype/covenant-demo
```

The existing `/prototype` route is untouched.

## Layout

- **Pane A — "You (human)"**: the `CertifyPassage` gesture (select a span → press
  and hold ✓) + the conversation as Pane A's replica sees it.
- **Pane B — "Agent peer"**: the SAME conversation (a second replica) + explicit
  peer-edit buttons. It has **no certify affordance** — a machine can never mint ✓.

A certified span carries a live glyph on BOTH panes: **`✓ certified`** (green) while
the exact signed content stands, **`~ drift`** (amber) on any drift or unverifiable
state. It updates within a render tick of the CRDT converging.

## Drive it — steps, expected glyph, rubric number

| # | Action | Expected | Rubric |
|---|--------|----------|--------|
| 1 | In Pane A, drag-select a passage of the hexi message (e.g. "streaming accumulation"), then press-and-hold **"Certify this passage"** (~2s) | A green **✓ certified** glyph appears on that message in **both** panes, bound to the selected span | 1 (happy certify), 11/12 (both panes agree), 2 (only the human pane can do this) |
| 2 | Pane B → **Edit one character [→3]** | Glyph flips to **~ drift** on **both** panes within a tick; the inserted char ("Z") appears in both | 3 (single-char drift), 12 |
| 3 | Pane B → **Revert last edit [→6]** | Glyph returns to **✓ certified** on both panes, with no re-certify | 6 (exact revert re-validates) |
| 4 | Pane B → **Look-alike swap [→10]** (inserts a zero-width space into the span) | **~ drift** on both — near-identical content does not validate | 10 (look-alike) |
| 5 | Pane B → **Revert last edit [→6]** | back to **✓ certified** | 6 |
| 6 | Pane B → **Edit OUTSIDE the span [→5]** (edits a *different* message) | The certified span stays **✓ certified** — an unrelated edit does not stale it | 5 (no collateral de-cert) |
| 7 | Pane B → **Change a format/mark [→4]** (bolds the span; no visible characters change) | **~ drift** on both — the digest is over rendered content, not plaintext | 4 (non-text mutation) |
| 8 | Pane B → **Forge a ✓ row [→9]** (appends a message asserting "certified ✓ by a human") | The forged row renders with **no ✓** at all — forged provenance is inert | 9 (forgery inert) |

Throughout, **no false ✓ ever appears** (rubric 8, cardinal): the glyph is `✓` only
when `resolveCovenant` returns `ok` over content byte-identical to what was signed.

## What is NOT built here (deferred, by scope)

- **True cross-BROWSER convergence + reconnect resync** (rubric 11/12 at the
  real-process level, and 16) is the Electric increment — not built here. Two panes
  in one page is the thin-slice convergence proof.
- The certify-ACT to the durable ledger (`certifyObjectSpanAction`), a server DETECT
  sweep, auth, and Postgres — all reserved/owned elsewhere (#204/#206/Lars).
- **Fail-closed on unverifiable state** (rubric 7) is proven in the unit suite
  (resolving an anchor against a doc where the span cannot resolve → `~`), not via a
  UI button.

## Verification

- Types: `pnpm --filter web typecheck` → 0 errors.
- Build: `pnpm --filter web build` → `/prototype/covenant-demo` compiles.
- Unit: `pnpm --filter web test -- test/covenant-demo-client.test.ts` → 10 pass
  (digest match→✓, one-char→~, format→~, outside-edit→✓, exact-revert→✓,
  zero-width→~, homoglyph→~, fail-closed→~, machine-refused).

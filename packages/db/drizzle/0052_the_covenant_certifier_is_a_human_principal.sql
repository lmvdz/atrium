-- ═════════════════════════════════════════════════════════════════════════════
-- THE COVENANT CERTIFIER NAMES A HUMAN PRINCIPAL — THE HALF THE CHECK CANNOT STATE.
--
-- Phase 6, #190 (SL-3 CERTIFY-PATH), routed from SL-1's dual-lineage gauntlet
-- (enforcement req 1, both foreign lineages' identical list). 0050 gives
-- `covenant_anchors` a CHECK:
--
--   > certifier_kind = 'human'          (covenant_anchors_certifier_is_human)
--
-- and its whole claim is that a PERSON vouched for the certified content (map
-- #162, #164 — "the machine never certifies"). The CHECK proves only that the
-- LABEL says human. A CHECK constraint sees one row of one table; it cannot look
-- across to `users` to learn whether `certifier_id` names a `principal_kind='human'`
-- identity. So
--
--   INSERT INTO covenant_anchors (certifier_kind, certifier_id, …)
--   VALUES ('human', '<an AGENT uuid>', …)
--
-- satisfies the CHECK — the label is 'human', the id is NOT NULL — while naming a
-- machine as the human that certified. That is the mint-bypass SL-1's gauntlet
-- named: an agent identity (which carries its own `users` row and speaks over the
-- same socket a person does, 0017) dressed as the human behind a `✓`. The gate
-- (`apps/web/lib/certify-anchor.ts`) sets `certifier_kind`/`certifier_id` from the
-- AUTHENTICATED SESSION's `principal_kind`, never from the request, and refuses a
-- non-human there; this trigger is the table backstop that holds if a future caller
-- skips the gate — the covenant must be refused at the gate AND the DB.
--
-- ## The mechanism, and why it is a trigger and not a foreign key
--
-- Exactly the shape 0021's `agents_user_is_agent`, 0024's `rooms_agent_user_is_agent`
-- and 0027's `proposals_agent_proposer_is_agent` use, for the same reason: this is
-- the reciprocal half a foreign key cannot state. `certifier_id` already REFERENCES
-- `users(id)` (ON DELETE SET NULL), so the id names a real identity — but a foreign
-- key cannot condition on the *kind* of the referenced row. A BEFORE INSERT OR UPDATE
-- trigger reads `users.principal_kind` and refuses the row when the named identity is
-- missing or is not a human. It takes no row lock (`principal_kind` is immutable —
-- `users_principal_kind_immutable`, 0017 §2, so there is no UPDATE to race) and fails
-- closed.
--
-- ## certifier_id is REQUIRED on INSERT
--
-- The FK is ON DELETE SET NULL so the anchor survives the certifier's later removal
-- (the signature happened) with a null pointer — exactly as `accepted_objects` does.
-- But a FRESH certification with no certifier_id is an anonymous `✓`, a signature
-- nobody put their name on, and the covenant's claim is precisely that a NAMED person
-- vouched. So on INSERT `certifier_id` must be present; the null pointer is only ever
-- a post-hoc consequence of deleting the user, never the state a row is minted in.
-- On UPDATE a null certifier_id is tolerated (that IS the ON DELETE SET NULL path,
-- and 0050/0051's immutability trigger governs every other column-change), so this
-- trigger checks the human-principal correlation only while the pointer is live.
--
-- The trigger has no `@atrium/db/schema` mirror, exactly as 0021/0024/0027 do not:
-- a plpgsql trigger is not a drizzle-representable object. It lives in the migration,
-- and the schema-parity suite holds the CHECK it completes. Like every trigger in
-- this schema, it does not bind an operator who disables triggers; the same limit
-- 0003 states.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION "atrium_covenant_anchor_certifier_is_human"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $covenant_anchor_certifier_is_human$
DECLARE
  v_kind text;
BEGIN
  -- A FRESH certification must name its certifier. A null certifier_id at INSERT is
  -- an anonymous `✓`; the null pointer is only ever a later ON DELETE SET NULL
  -- consequence, never a state a row is minted in.
  IF TG_OP = 'INSERT' AND NEW."certifier_id" IS NULL THEN
    RAISE EXCEPTION
      'covenant anchor %: a certification must name its certifier — a `✓` is a signature a named person put on this exact content, never an anonymous one', NEW."id"
      USING ERRCODE = '23514', CONSTRAINT = 'covenant_anchor_certifier_is_human';
  END IF;

  -- No live pointer to correlate (the ON DELETE SET NULL path on UPDATE): the
  -- immutability trigger (0050/0051) governs every other change, and there is no
  -- principal to check against a null id.
  IF NEW."certifier_id" IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT u."principal_kind"::text INTO v_kind
  FROM public."users" u WHERE u."id" = NEW."certifier_id";
  IF v_kind IS NULL THEN
    RAISE EXCEPTION
      'covenant anchor %: certifier_id "%" is not an identity in this database, but a `✓` must name the human that certified it', NEW."id", NEW."certifier_id"
      USING ERRCODE = '23514', CONSTRAINT = 'covenant_anchor_certifier_is_human';
  END IF;
  IF v_kind <> 'human' THEN
    RAISE EXCEPTION
      'covenant anchor %: certifier_id "%" is a % principal, but the machine never certifies — only a human may vouch for the exact rendered content of a span (#162/#164); a machine drafts a reading (~) and lets a person certify it (✓)', NEW."id", NEW."certifier_id", v_kind
      USING ERRCODE = '23514', CONSTRAINT = 'covenant_anchor_certifier_is_human';
  END IF;
  RETURN NEW;
END;
$covenant_anchor_certifier_is_human$;--> statement-breakpoint

CREATE TRIGGER "covenant_anchor_certifier_is_human"
  BEFORE INSERT OR UPDATE ON "covenant_anchors"
  FOR EACH ROW EXECUTE FUNCTION "atrium_covenant_anchor_certifier_is_human"();--> statement-breakpoint

COMMENT ON FUNCTION "atrium_covenant_anchor_certifier_is_human"() IS
  'Refuses any covenant_anchors row whose certifier_id names a users row that is not principal_kind=human, and any INSERT with a null certifier_id (#190 SL-3, from SL-1 gauntlet enforcement req 1). The half covenant_anchors_certifier_is_human (0050) cannot state: a CHECK proves certifier_kind=''human'' but cannot cross to users.principal_kind, so an agent uuid dressed as the human behind a ✓ (the mint-bypass) satisfies the CHECK. The gate (apps/web/lib/certify-anchor.ts) sets certifier_kind/id from the authenticated session, never the request; this is the table backstop — the covenant is refused at the gate AND the DB. Mirrors 0021/0024/0027. Fires BEFORE INSERT OR UPDATE; no row lock (principal_kind is immutable, 0017). Tolerates a null certifier_id on UPDATE (the ON DELETE SET NULL path). Does not bind an operator who disables triggers.';--> statement-breakpoint

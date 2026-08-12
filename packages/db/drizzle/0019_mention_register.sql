-- ═════════════════════════════════════════════════════════════════════════════
-- ONE REGISTER FOR "WHO WAS NAMED HERE", AND AN AGENT MAY BE NAMED.
--
-- ## The two things this migration does, and why they are one migration
--
-- Decision #92: `message_references` is the single register for who a message
-- named; `messages.mention_user_ids` goes. The column has been dead for real
-- traffic since typed references landed — the client fills `message_references`
-- and never `mention_user_ids` (four independent confirmations, #91 brief) — yet
-- a second subsystem (`mentionSignals` in apps/server) still computed mention
-- targets from it. Teaching the unfilled column to be authoritative would mean
-- teaching a second writer to fill what references already carry. So the column
-- is dropped and every reader is repointed at the one register.
--
-- The same edit that collapses the register also opens it to agents (#100). An
-- agent is a `users` row with a membership and a session (drizzle/0017), so a
-- person can @-mention it exactly as they mention another person, and the
-- reference lands the agent's attention row through the same path a human's
-- does. Naming an agent needs a value in the reference alphabet, so the enum
-- grows one; the two anonymous actor kinds (`model`, `system`) carry no identity
-- to be a target and are deliberately NOT added.
--
-- ## `ALTER TYPE … ADD VALUE` inside the migration transaction
--
-- drizzle's migrator runs every pending migration in one transaction. Postgres
-- 12+ permits `ALTER TYPE … ADD VALUE` there but refuses to *use* the new label
-- in the same transaction. The trigger below is replaced in this same file and
-- its CASE mentions the new `agent` label — so, exactly as drizzle/0017 did for
-- `actor_kind`, the CASE is written on `NEW.kind::text`, which resolves no enum
-- label at all, and a plpgsql body is not analysed until it first runs (a later
-- transaction, after this one commits). Written that way on purpose, not by
-- luck: the `::text` spelling is what makes this file safe to apply alongside the
-- ADD VALUE above it.
-- ═════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. The reference alphabet gains its second participant kind.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TYPE "public"."message_reference_kind" ADD VALUE IF NOT EXISTS 'agent' AFTER 'human';--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. The reference-target guard learns `agent`, and anchors each participant
--    kind to a member whose OWN principal_kind agrees.
--
-- Carried forward from drizzle/0016 verbatim except for the CASE: the surface
-- check, the ordinal-contiguity check and the span-overlap check are unchanged,
-- and this file is now the newest definition of the whole function. The change:
-- a `human` reference must name a room member whose `users.principal_kind` is
-- `human`, and an `agent` reference must name a member whose principal_kind is
-- `agent`. Before this migration `human` was anchored to bare membership, which
-- was correct only while every member was a person; the moment an agent holds a
-- membership, membership alone would let a `human` reference name an agent (or an
-- `agent` reference name a person). Deriving the check from the target's own
-- principal row — the same row that authorized the membership — closes that
-- mislabel in both directions, and there is no list to keep in step.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION "validate_message_reference_target"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_exists boolean := false;
  authored_body text;
BEGIN
  SELECT m.body INTO authored_body
  FROM messages m WHERE m.room_id = NEW.room_id AND m.id = NEW.message_id;
  IF authored_body IS NULL OR atrium_utf16_slice(authored_body, NEW.start, NEW."end") IS DISTINCT FROM NEW.surface THEN
    RAISE EXCEPTION 'message reference surface does not match authored body' USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' AND NEW.ordinal <> (
    SELECT count(*)::integer FROM message_references r WHERE r.message_id = NEW.message_id
  ) THEN
    RAISE EXCEPTION 'message reference ordinal is not contiguous' USING ERRCODE = '23514';
  END IF;

  -- `NEW.kind::text` so the `agent` label added in this same transaction is not
  -- resolved here; see this file's header.
  CASE NEW.kind::text
    WHEN 'human' THEN
      SELECT EXISTS (
        SELECT 1 FROM memberships m
        JOIN users u ON u.id = m.user_id
        WHERE m.room_id = NEW.room_id AND m.user_id = NEW.target_id
          AND u.principal_kind = 'human'
      ) INTO target_exists;
    WHEN 'agent' THEN
      SELECT EXISTS (
        SELECT 1 FROM memberships m
        JOIN users u ON u.id = m.user_id
        WHERE m.room_id = NEW.room_id AND m.user_id = NEW.target_id
          AND u.principal_kind = 'agent'
      ) INTO target_exists;
    WHEN 'attachment' THEN
      SELECT EXISTS (SELECT 1 FROM attachments a WHERE a.room_id = NEW.room_id AND a.id = NEW.target_id AND a.claimed_by_message_id = NEW.message_id) INTO target_exists;
    WHEN 'proposal' THEN
      SELECT EXISTS (SELECT 1 FROM proposals p WHERE p.room_id = NEW.room_id AND p.id = NEW.target_id) INTO target_exists;
    WHEN 'object' THEN
      SELECT EXISTS (SELECT 1 FROM accepted_objects o WHERE o.room_id = NEW.room_id AND o.id = NEW.target_id) INTO target_exists;
    ELSE
      RAISE EXCEPTION 'unsupported message reference kind' USING ERRCODE = '23514';
  END CASE;
  IF NOT target_exists THEN RAISE EXCEPTION 'message reference target unavailable' USING ERRCODE = '23514'; END IF;

  IF EXISTS (
    SELECT 1 FROM message_references r
    WHERE r.message_id = NEW.message_id AND r.id <> NEW.id
      AND int4range(r.start, r."end", '[)') && int4range(NEW.start, NEW."end", '[)')
  ) THEN
    RAISE EXCEPTION 'message reference spans overlap' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

COMMENT ON FUNCTION "validate_message_reference_target"() IS
  'Validates every message_references row against stored room data, never against the caller. Anchors each of the two participant reference kinds to a member whose own users.principal_kind agrees — a human reference to a human member, an agent reference to an agent member — so neither identity kind can be named as the other now that both hold memberships (#100). Attachment, proposal and object targets are anchored to their own rooms as before. The CASE reads NEW.kind::text so the agent label added by drizzle/0019 in the same transaction is not resolved at apply time.';--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. The retired register. `message_references` is the only one now.
--
-- Nothing in the SCHEMA depends on this column: only drizzle/0013 ever named it,
-- no trigger, view or generated column reads it, and the sole product reader
-- (mentionSignals) has been repointed at message_references in the same change
-- set. But the DATA is a different question. An earlier claim here read "the
-- client has never filled it" — true of the CLIENT, and false as stated: the
-- SERVER write path existed (projections.ts wrote `event.mentionUserIds` and
-- room-events.ts accepted it on the wire), so git history contradicts "never
-- filled" and a real deployment could carry legacy values in this column.
--
-- Dropping it outright would silently lose those values, and with them the
-- mention attention of every message that carried one — a lossy drop where the
-- decision (#92) said *collapse*. A backfill into `message_references` is NOT
-- available as the safe alternative: a reference is anchored to a body span
-- (`start`/`end`/`surface`, validated by the trigger above against the authored
-- text), and `mention_user_ids` is a bare `uuid[]` with no offset, no surface
-- and no ordinal — there is no honest span to synthesise from a naked id list,
-- so any backfill would be a fabrication the trigger would (rightly) reject.
--
-- So the migration REFUSES rather than guesses: if any row still carries a
-- non-empty `mention_user_ids`, it raises and leaves the column in place, and an
-- operator must collapse those legacy values into `message_references`
-- deliberately (re-deriving each mention's span from the message body) before
-- re-running. A fresh database — the launch case (#103) — has no such rows and
-- passes straight through. The guard reads the same column the DROP removes, so
-- it cannot be satisfied by anything the caller supplies.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM messages
    WHERE mention_user_ids IS NOT NULL AND array_length(mention_user_ids, 1) > 0
  ) THEN
    RAISE EXCEPTION
      'refusing to drop messages.mention_user_ids: % row(s) still carry a non-empty legacy value, and the drop would silently lose their mention attention. Collapse each into message_references (re-deriving the @-span from the message body) before re-running this migration; a bare uuid[] has no offset/surface to back-fill automatically.',
      (SELECT count(*) FROM messages WHERE mention_user_ids IS NOT NULL AND array_length(mention_user_ids, 1) > 0)
      USING ERRCODE = '23514';
  END IF;
END $$;--> statement-breakpoint

ALTER TABLE "messages" DROP COLUMN "mention_user_ids";

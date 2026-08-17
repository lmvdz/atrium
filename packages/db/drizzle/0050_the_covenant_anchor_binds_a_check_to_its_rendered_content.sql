-- ═════════════════════════════════════════════════════════════════════════════
-- THE COVENANT ANCHOR — a `✓` on a CRDT span binds to its EXACT rendered content.
--
-- Phase 6, #180; governed by #163 (complete-form re-resolution) and #164
-- (DETECT-only, fail-closed — there is NO hard span lock). Map #162.
--
-- Session certify already content-anchors a `✓`: 0034 froze a session's artifact
-- under its signature and bound the certification to `md5(artifact::text)`. That
-- is the OBJECT-less axis. This migration brings the identical discipline —
-- "a `✓` is a signature OF a specific rendered thing, and any change underneath
-- the signature is detectable" — to the OBJECT/SPAN axis, where the thing signed
-- is a span of the live Yjs document that agent-peers can edit.
--
-- The round-2 gauntlet ruled a bare `state_vector` a WELL-FORMED LIE: a state
-- vector and relative positions preserve CRDT *structure*, not rendered
-- *meaning*, so an anchor resolving against them alone can report OK over content
-- that reads differently to a human. The COMPLETE form (#163) therefore carries,
-- and the read authority (#181) re-checks, all of:
--
--   * `revision`        — the logical revision the `✓` was bound to.
--   * `state_vector`    — resolution context: resolve the anchored positions
--                         against the doc as of that revision, and detect GC /
--                         a foreign document. Opaque, caller-encoded bytes.
--   * `delete_set`      — resolution context: what was deleted as of the snapshot.
--   * `enclosed_items`  — the IDENTITY of every item inside the span, so deleting
--                         one is detectable as an identity change, not only a
--                         content change.
--   * `rendered_digest` — SHA-256 of the canonical RENDERED fragment (ancestor
--                         formatting + inline marks incl. straddling ones +
--                         transitive embed / overlay identity). The meaning check
--                         the bare state vector could not make.
--
-- Authority lives on the gated ledger, never in the CRDT: this is a Postgres row
-- the room reads read-only, not a Yjs field. `@atrium/core`'s `resolveCovenant()`
-- resolves the anchor against the live doc and answers OK / DRIFT; this table owns
-- only the persistence and the certify-time capture. Migrating every reader onto
-- it (#181) and scheduling drift checks (#182) are separate tickets.
--
-- Like every trigger in this schema, the immutability below does not bind an
-- operator who disables triggers; the same limit 0003 states.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TABLE "covenant_anchors" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "room_id" uuid NOT NULL,
  "object_id" uuid NOT NULL,
  "revision" integer NOT NULL,
  "state_vector" text NOT NULL,
  "delete_set" text NOT NULL,
  "enclosed_items" jsonb NOT NULL,
  "rendered_digest" text NOT NULL,
  "certifier_kind" "actor_kind" NOT NULL,
  "certifier_id" uuid,
  "certified_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  -- A rendered digest is a SHA-256: 64 lower-case hex characters. A malformed
  -- digest is a lie the table refuses, the same backstop 0034 gives md5.
  CONSTRAINT "covenant_anchors_digest_is_sha256" CHECK ("covenant_anchors"."rendered_digest" ~ '^[0-9a-f]{64}$'),
  -- Only a human certifies. The covenant's whole claim is that a PERSON vouched
  -- for this content (map #162, #164); a machine `✓` is a category error.
  CONSTRAINT "covenant_anchors_certifier_is_human" CHECK ("covenant_anchors"."certifier_kind" = 'human'),
  CONSTRAINT "covenant_anchors_revision_nonneg" CHECK ("covenant_anchors"."revision" >= 0)
);--> statement-breakpoint

COMMENT ON TABLE "covenant_anchors" IS
  'The complete covenant anchor (#180/#163): the record a human `✓` on a Yjs span binds to, such that any drift from the exact certified rendered content makes it fail to resolve (DETECT-only, fail-closed, #164). The object/span analogue of the session artifact anchor (0034). Authority on the gated ledger, resolved by @atrium/core resolveCovenant(); readers migrate in #181, drift is scheduled in #182.';--> statement-breakpoint

-- The room is the isolation boundary; the anchor dies with its room.
ALTER TABLE "covenant_anchors" ADD CONSTRAINT "covenant_anchors_room_id_fk"
  FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade;--> statement-breakpoint

-- The certifier is a user; keep the anchor if the user is later removed (the
-- signature happened), but null the pointer, exactly as accepted_objects does.
ALTER TABLE "covenant_anchors" ADD CONSTRAINT "covenant_anchors_certifier_id_fk"
  FOREIGN KEY ("certifier_id") REFERENCES "public"."users"("id") ON DELETE set null;--> statement-breakpoint

-- COMPOSITE, like every reference out of a semantic row: the certified span is an
-- accepted object IN THIS ROOM, never one borrowed from another room.
ALTER TABLE "covenant_anchors" ADD CONSTRAINT "covenant_anchors_object_same_room_fk"
  FOREIGN KEY ("room_id","object_id") REFERENCES "public"."accepted_objects"("room_id","id");--> statement-breakpoint

-- One live anchor per certified span — the current `✓`. Re-certify is a new human
-- act that REPLACES it (delete + insert of a fresh signature), never a silent
-- rewrite of the one below.
CREATE UNIQUE INDEX "covenant_anchors_object_key" ON "covenant_anchors" ("room_id","object_id");--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- The signed fields are frozen once written — EXTENDS 0034's discipline to the
-- span axis. A certification is a human act recorded once; the digest, the
-- resolution context, the enclosed identity and the certifier are WHAT WAS
-- SIGNED and may not change underneath the signature. Re-certify replaces the
-- row (a new signature); it does not UPDATE these columns. Same `IS DISTINCT
-- FROM` shape 0034 uses, so a no-op UPDATE of identical values passes while any
-- real change is refused.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION "atrium_covenant_anchor_immutable"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $covenant_anchor_immutable$
BEGIN
  IF NEW."rendered_digest"  IS DISTINCT FROM OLD."rendered_digest"
     OR NEW."state_vector"  IS DISTINCT FROM OLD."state_vector"
     OR NEW."delete_set"    IS DISTINCT FROM OLD."delete_set"
     OR NEW."enclosed_items" IS DISTINCT FROM OLD."enclosed_items"
     OR NEW."revision"      IS DISTINCT FROM OLD."revision"
     OR NEW."certifier_kind" IS DISTINCT FROM OLD."certifier_kind"
     OR NEW."certifier_id"  IS DISTINCT FROM OLD."certifier_id"
     OR NEW."certified_at"  IS DISTINCT FROM OLD."certified_at"
     OR NEW."object_id"     IS DISTINCT FROM OLD."object_id"
     OR NEW."room_id"       IS DISTINCT FROM OLD."room_id" THEN
    RAISE EXCEPTION
      'covenant anchor % is a human signature recorded once and may not be rewritten — re-certification replaces it with a new anchor, it does not edit what was signed',
      OLD."id"
      USING ERRCODE = '23514', CONSTRAINT = 'covenant_anchor_immutable';
  END IF;
  RETURN NEW;
END;
$covenant_anchor_immutable$;--> statement-breakpoint

CREATE TRIGGER "covenant_anchor_immutable"
  BEFORE UPDATE ON "covenant_anchors"
  FOR EACH ROW EXECUTE FUNCTION "atrium_covenant_anchor_immutable"();--> statement-breakpoint

COMMENT ON FUNCTION "atrium_covenant_anchor_immutable"() IS
  'Refuses any UPDATE that changes the signed fields of a covenant anchor — rendered_digest, state_vector, delete_set, enclosed_items, revision, certifier_kind/id, certified_at, or the (room_id, object_id) it is over. A `✓` binds to the EXACT rendered content it signed (#180/#163); re-certification is a new human act that replaces the row, not an edit of the one below. Extends 0034 to the object/span axis. Does not bind an operator who disables triggers; the same limit 0003 states.';--> statement-breakpoint

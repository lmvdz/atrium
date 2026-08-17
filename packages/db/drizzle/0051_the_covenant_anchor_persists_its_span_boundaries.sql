-- ═════════════════════════════════════════════════════════════════════════════
-- THE COVENANT ANCHOR PERSISTS ITS SPAN BOUNDARIES — rel_start / rel_end.
--
-- Phase 6, #180 fix-round; governed by #163 (complete form) and #164 (DETECT-only,
-- fail-closed). The round-2 fix-round gauntlet ruled 0050 incomplete: the span's
-- relative-position boundaries lived only on the reader INSTANCE, never on the
-- anchor, so `resolveCovenant` could not locate the span after a reader reload and
-- a sibling inserted at the same index resolved a false `✓` against the wrong
-- (empty) block. The boundaries are part of WHAT WAS SIGNED and must be on the
-- ledger row the read authority (#181) loads, not reconstructed from live state.
--
--   * `rel_start` — opaque, caller-encoded Yjs RelativePosition of the span start.
--   * `rel_end`   — opaque, caller-encoded Yjs RelativePosition of the span end.
--
-- With the boundaries persisted, resolution is: decode rel_start/rel_end, resolve
-- them against the LIVE doc (a position that no longer resolves ⇒ the span is gone
-- ⇒ DRIFT, fail-closed), render the enclosed range, and compare the digest. A
-- reader with no in-memory state resolves the anchor from these columns alone.
--
-- The table is brand-new in 0050 with no production insert path yet (#181 builds
-- the reader that writes it), so the columns are added NOT NULL via a transient
-- empty-string default that is then dropped — the same shape the repo uses to add
-- a required column, and honest here because no row predates it.
-- ═════════════════════════════════════════════════════════════════════════════

ALTER TABLE "covenant_anchors" ADD COLUMN "rel_start" text NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE "covenant_anchors" ADD COLUMN "rel_end" text NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE "covenant_anchors" ALTER COLUMN "rel_start" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "covenant_anchors" ALTER COLUMN "rel_end" DROP DEFAULT;--> statement-breakpoint

COMMENT ON COLUMN "covenant_anchors"."rel_start" IS
  'Opaque, caller-encoded Yjs RelativePosition of the certified span start (#180 fix-round). Persisted so resolveCovenant locates the span from the ledger after a reader reload; a sibling inserted at the same index cannot redirect the anchor to it. Part of what was signed — frozen by the immutability trigger.';--> statement-breakpoint
COMMENT ON COLUMN "covenant_anchors"."rel_end" IS
  'Opaque, caller-encoded Yjs RelativePosition of the certified span end (#180 fix-round). See rel_start.';--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- The span boundaries are SIGNED fields: freeze them alongside the digest, state
-- vector, delete set, enclosed identity, revision and certifier that 0050 already
-- freezes. Re-certify replaces the row (a new signature); it does not edit which
-- span was signed. CREATE OR REPLACE keeps 0050's function body and adds the two
-- new guards — same `IS DISTINCT FROM` shape, so a no-op UPDATE still passes.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION "atrium_covenant_anchor_immutable"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $covenant_anchor_immutable$
BEGIN
  IF NEW."rendered_digest"  IS DISTINCT FROM OLD."rendered_digest"
     OR NEW."rel_start"     IS DISTINCT FROM OLD."rel_start"
     OR NEW."rel_end"       IS DISTINCT FROM OLD."rel_end"
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

-- ═════════════════════════════════════════════════════════════════════════════
-- A CERTIFICATION NEEDS A *REVIEWABLE* ARTIFACT, NOT MERELY A NON-NULL ONE.
--
-- #121 round-6 finding 2. 0034 made "a certifier requires an artifact" a table
-- fact, but it checked only `artifact IS NULL`. `SessionArtifact` has every field
-- optional (packages/db/src/schema.ts), so an empty `{}` — or a half-filled
-- `{ "branch": "x" }` — is non-null JSONB that 0034 accepts. A coherent hold
-- receipt over `{}` then earned a human `✓` on an artifact with nothing in it to
-- review: a signature on a blank page, one UPDATE from being written.
--
-- A `✓` is a signature OF something specific. The least that makes "this human
-- signed THIS artifact" mean anything is a branch AND a commit, both non-empty —
-- the minimum reviewable content the review pane shows and a person reads. This
-- REPLACES 0034's function body (CREATE OR REPLACE, same function, same trigger)
-- to require exactly that, schema-qualified `public."…"` so it resolves under the
-- house search_path the way 0036's consistency trigger already does. Whitespace is
-- empty: `trim(…) = ''` rejects a branch of spaces. The application guard
-- (apps/web/lib/certify-hold.ts `isReviewableArtifact`) and the render backstop
-- (src/components/control/state.ts) read the same shape; this is the table under
-- both, the twin of 0032/0033/0035/0036.
--
-- Like every trigger in this schema, none of this binds an operator who disables
-- triggers; the same limit 0003 states.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION "public"."atrium_sessions_certify_needs_artifact"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $certify_needs_artifact$
BEGIN
  IF NEW."certified_by" IS NOT NULL AND (
       NEW."artifact" IS NULL
       OR coalesce(trim(NEW."artifact"->>'branch'), '') = ''
       OR coalesce(trim(NEW."artifact"->>'commit'), '') = ''
     ) THEN
    RAISE EXCEPTION
      'session %: a certification is a signature on a reviewable artifact, and this one has no branch+commit to sign — a % cannot certify empty work',
      NEW."id", NEW."certified_by"
      USING ERRCODE = '23514', CONSTRAINT = 'sessions_certify_needs_artifact';
  END IF;
  RETURN NEW;
END;
$certify_needs_artifact$;--> statement-breakpoint

COMMENT ON FUNCTION "public"."atrium_sessions_certify_needs_artifact"() IS
  'Refuses any sessions row whose certified_by is non-null while its artifact is not REVIEWABLE — null, or missing a non-empty branch AND commit (#121 round-6 finding 2). A `✓` is a signature OF something specific; an empty {} that 0034''s null-only check accepted is a signature on a blank page. Extends 0034''s needs-artifact backstop; the app guard (isReviewableArtifact) and the render fail closed on the same shape. Does not bind an operator who disables triggers; the same limit 0003 states.';--> statement-breakpoint

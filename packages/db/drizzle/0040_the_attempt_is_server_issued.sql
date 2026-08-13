-- ═════════════════════════════════════════════════════════════════════════════
-- THE CERTIFY ATTEMPT IS SERVER-ISSUED — DROP THE CLIENT SEQUENCE AND WATERMARK.
--
-- #121 round-7 finding 2. Round 6 (drizzle/0039) threaded a CLIENT-minted,
-- strictly-monotonic `attemptSeq` through the certify arm/disarm/confirm and
-- raised it into a session-global cancel watermark (`certify_cancel_seq`). Both
-- were authority values the client supplied, and that was the hole:
--
--   * a disarm raised `certify_cancel_seq` to WHATEVER the caller sent, with no
--     arm and no bound — so `disarm(attemptSeq = 9007199254740991)` set an
--     unbounded, session-global watermark that refused every honest arm forever
--     (`arm_superseded`). A denial of service any member could fire in one call,
--     and cross-client clock skew tripped it by accident;
--   * `certify_arm_seq` was the client's counter for the live arm, correlating the
--     disarm and confirm of a press — but a client value the server merely stored.
--
-- The attempt is SERVER-ISSUED now. `certify_arm_nonce` (drizzle/0037) is the whole
-- of an attempt's identity: `armCertification` mints it and RETURNS it, and the
-- confirm and disarm carry that opaque token back so the server can bind them to
-- the exact press. Nothing the client counts reaches the row, so nothing the client
-- counts can jam a future arm. These two columns are dead; drop them.
--
-- Neither was in any trigger or constraint (0039 deliberately left them out of
-- 0034's frozen set), so the drop touches nothing else. `IF EXISTS` so a database
-- that never reached 0039 — none should, but a partial history is not a crash — is
-- a no-op rather than an error.
-- ═════════════════════════════════════════════════════════════════════════════

ALTER TABLE "sessions" DROP COLUMN IF EXISTS "certify_arm_seq";--> statement-breakpoint
ALTER TABLE "sessions" DROP COLUMN IF EXISTS "certify_cancel_seq";

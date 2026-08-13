-- ═════════════════════════════════════════════════════════════════════════════
-- THE ARM CARRIES A SINGLE-USE NONCE AND A DIGEST OF THE ARTIFACT REVIEWED.
--
-- #121 fix round, round-5 findings 3 and 5. Two columns the arm→confirm protocol
-- needs, both NULL except while a hold is pending:
--
--   * certify_arm_nonce — a fresh gen_random_uuid() stamped at arm and CONSUMED by
--     the confirm that spends it (finding 5). The gauntlet found a server arm that
--     survived its whole 120s TTL, so "a later direct confirm spends it": the arm
--     was a standing window, not a single-use attempt. The confirm now honours only
--     an arm that carries a live nonce — the nonce is minted by armCertification
--     alone and cleared the instant it is spent (or on disarm), so a leaked or
--     hand-forged arm is not a confirmable attempt, and an arm is confirmable once.
--
--   * certify_armed_artifact_digest — md5(artifact::text) of the artifact ON SCREEN
--     when the hold was armed (finding 3). Certification bound to "an" artifact,
--     not the reviewed one: render A, change it to B before confirming, and 0034
--     froze B under a `✓` for work nobody looked at. The confirm recomputes the
--     digest and refuses if the artifact moved underneath the hold, so the `✓`
--     binds to the revision the person actually reviewed.
--
-- Nullable, no default: an uncertified row with no pending hold carries neither.
-- The freeze once certified (0034's immutability) is deliberately NOT extended to
-- them — the confirm clears both to null as it lands the signature, and a null on
-- a certified row is inert (nothing reads an arm nonce or digest once certified_by
-- is set). Adding them to the frozen set would only forbid that clearing.
-- ═════════════════════════════════════════════════════════════════════════════

ALTER TABLE "sessions" ADD COLUMN "certify_arm_nonce" uuid;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "certify_armed_artifact_digest" text;--> statement-breakpoint

COMMENT ON COLUMN "sessions"."certify_arm_nonce" IS
  'The single-use attempt id of a pending certification hold (#121 finding 5). A fresh gen_random_uuid() at arm, consumed (set null) by the confirm that spends it and cleared on disarm. The confirm honours only an arm carrying a live nonce, so a leaked or forged arm is not a confirmable attempt and an arm is spent at most once. NULL except while a hold is pending.';--> statement-breakpoint

COMMENT ON COLUMN "sessions"."certify_armed_artifact_digest" IS
  'md5(artifact::text) of the artifact under review when the hold was armed (#121 finding 3). The confirm recomputes it and refuses if the artifact changed between arm and signature, binding the `✓` to the reviewed revision rather than to whatever the artifact became. NULL except while a hold is pending; consumed on confirm, cleared on disarm.';--> statement-breakpoint

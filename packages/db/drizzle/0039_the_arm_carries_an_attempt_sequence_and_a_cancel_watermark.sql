-- ═════════════════════════════════════════════════════════════════════════════
-- THE ARM CARRIES AN ATTEMPT SEQUENCE, AND THE SESSION A CANCEL WATERMARK.
--
-- #121 round-6 finding 3. A server arm and a server disarm are two independent
-- round-trips the network may REORDER. The gauntlet found the ordering that
-- mattered: begin→arm R1 fired, then release→disarm R2 fired, but R2 reached the
-- server first and cleared nothing (no arm was there yet), and the delayed R1 then
-- wrote a fresh live nonce — so a direct confirm after the gate certified despite
-- the release. The disarm was not correlated to the attempt it cancelled.
--
-- Two nullable columns close it, both threaded by a per-press sequence the CLIENT
-- mints at hold-begin (the only place with the identity of one press) and carries
-- identically on the arm, the disarm and the confirm:
--
--   * certify_arm_seq — the live arm's attempt sequence. The disarm clears the arm
--     only when this is the attempt it is cancelling; the confirm honours only an
--     arm carrying the sequence it is completing. NULL when no hold is pending;
--     consumed (set null) by the confirm, cleared on disarm.
--
--   * certify_cancel_seq — the cancel watermark. A disarm raises it to at least its
--     own attempt's sequence UNCONDITIONALLY, even when its arm has not yet landed.
--     An arm whose sequence is at or below the watermark then refuses (the release
--     for this attempt, or a newer one, already happened), so a late arm cannot
--     resurrect a cancelled hold. A fresh press mints a strictly larger sequence
--     and arms cleanly. Inert once certified — nothing reads it after certified_by
--     is set.
--
-- These order and correlate a single client's own requests; they are NOT a timing
-- the gate trusts. The held duration is still `now() - certify_armed_at`, measured
-- server-side (the CS-2 property this whole path exists to keep).
--
-- Nullable, no default. Deliberately NOT added to 0034's immutability frozen set:
-- the confirm clears certify_arm_seq to null as it lands the signature, and a null
-- on a certified row is inert — freezing it would only forbid that clearing, the
-- same reasoning 0037 states for the nonce and the digest.
-- ═════════════════════════════════════════════════════════════════════════════

ALTER TABLE "sessions" ADD COLUMN "certify_arm_seq" bigint;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "certify_cancel_seq" bigint;--> statement-breakpoint

COMMENT ON COLUMN "sessions"."certify_arm_seq" IS
  'The live certification arm''s client-minted attempt sequence (#121 round-6 finding 3). Carried identically on the arm, disarm and confirm of one hold so a release correlates to the arm it cancels and a confirm completes the press it began. NULL except while a hold is pending; consumed on confirm, cleared on disarm.';--> statement-breakpoint

COMMENT ON COLUMN "sessions"."certify_cancel_seq" IS
  'The cancel watermark: the highest attempt sequence any release has cancelled for this session (#121 round-6 finding 3). A disarm raises it even when its arm has not yet landed, and an arm at or below it refuses — so a late arm cannot outrun the release that superseded it. Inert once certified. Starts null.';--> statement-breakpoint

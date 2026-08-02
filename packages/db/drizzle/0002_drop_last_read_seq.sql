-- `seen_seq` (issue #22) replaced `last_read_seq`: same meaning, widened to
-- bigint so the read cursor cannot overflow before the `core_events.room_seq`
-- it points into. 0001 added it and copied every value across; this drops the
-- column it superseded, in a separate migration so the copy is durable before
-- the original goes.
ALTER TABLE "memberships" DROP COLUMN "last_read_seq";

-- A retry receipt is owned by (room, authenticated actor, command, key). The
-- message projection must reserve the same namespace: a room-global client key
-- lets one member preempt another member's otherwise valid send.
DROP INDEX "messages_room_client_id_key";--> statement-breakpoint
CREATE UNIQUE INDEX "messages_room_author_client_id_key" ON "messages" USING btree ("room_id","author_id","client_message_id");

-- Mention routing is structured message metadata. A person's body remains
-- byte-for-byte authored speech; UUID protocol syntax never enters it.
ALTER TABLE "messages"
  ADD COLUMN "mention_user_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;

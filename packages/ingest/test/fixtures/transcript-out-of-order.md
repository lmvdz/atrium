Someone pasted this out of a client that groups by sub-thread rather than by
clock, so transcript order and timestamp order disagree — and they disagree
right on a reply edge, which is where it stops being cosmetic.

## alice — 2024-03-01T09:00:00Z
Do we ship the migration behind a flag?

## bob — 2024-03-01T09:20:00Z
Yes. I'll write it.

## carol — 2024-03-01T09:05:00Z [reply to #2]
Only if the backfill is idempotent.

## dave — 2024-03-01T09:40:00Z
Filed as #412.

Pasted out of a chat client. Everything above the first header is preamble
and is ignored by the converter.

## alice — 2024-03-01T09:00:00Z
We need to decide on the storage layer before Friday.

**Worth noting** that a bold run mid-paragraph is not a speaker header — it
carries no timestamp and no colon, so it stays in the body.

### bob (2024-03-01 09:04) [reply to #1]
Postgres. We already run it, and `jsonb` covers the flexible bits.

```ts
## this line looks like a header but it is inside a fence
const storage = 'postgres';
```

**carol** 2024-03-01 11:11 +02:00
Agreed — Postgres it is. Sketch: ![schema sketch](https://example.com/sketch.png)

**dave**:
No timestamp here, so this message inherits carol's.

## erin — 2024-03-01 10:00 (replying to #3)
I'll write the migration by Wednesday.

# Research: LLM provider and structured-output stack

Wayfinder ticket #7. Researched 2026-07-31 for the Atrium interpretation pass (typed semantic proposals — decisions, commitments, open questions, claims — with confidence + provenance, run after every chat message).

## Sources

- Anthropic model/pricing reference — Claude API skill cache (dated 2026-06-24) and `platform.claude.com/docs/en/pricing` (redirects/404s on direct fetch as of 2026-07-31; cross-checked via search) — [Introducing Claude Sonnet 5](https://www.anthropic.com/news/claude-sonnet-5), [Claude Sonnet 5 intro pricing deadline](https://finopsllm.com/research/sonnet-5-intro-pricing-deadline)
- OpenAI GPT-5.6 pricing — `https://developers.openai.com/api/docs/pricing` (fetched 2026-07-31, reflects the 2026-07-30 price cut on Terra/Luna)
- Gemini pricing — `https://ai.google.dev/gemini-api/docs/pricing` (fetched 2026-07-31)
- Vercel AI SDK `generateObject` / structured output — [Vercel AI SDK docs](https://vercel.com/docs), [AI SDK 6 blog post](https://vercel.com/blog/ai-sdk-6), [Structured Output — Vercel Academy](https://vercel.com/academy/ai-summary-app-with-nextjs/structured-output)
- Vercel AI Gateway pricing/fallback/observability — [Observability and Spend](https://vercel.com/docs/ai-gateway/observability-and-spend), [Vercel AI Gateway vs OpenRouter](https://vercel.com/i/vercel-ai-gateway-vs-openrouter), [Cost-aware model routing](https://vercel.com/kb/guide/cost-aware-model-routing-with-ai-gateway)
- Cross-provider structured-output libraries — [Instructor](https://python.useinstructor.com/), [Instructor GitHub](https://github.com/567-labs/instructor), [BAML vs Instructor benchmark](https://www.glukhov.org/llm-performance/benchmarks/baml-vs-instruct-for-structured-output-llm-in-python/)
- Structured-output reliability figures — [OpenAI structured outputs vs JSON mode](https://www.respan.ai/articles/openai-structured-outputs-vs-json-mode), [Anthropic structured outputs docs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs), [Gemini structured output guide](https://oneuptime.com/blog/post/2026-02-17-how-to-use-gemini-structured-output-and-json-mode-for-reliable-data-extraction/view)

Atrium's own architecture doc (`init.md`, "The recommended greenfield architecture" / "What Atrium should actually build") already commits to TypeScript/Node/Next.js/Postgres and calls for "Provider-neutral structured LLM calls" as a named stack component — this research resolves that line item.

## 1. Calling-layer comparison

| Option | Structured-output mechanism | Provider neutrality | Retry/validation ergonomics | Streaming | Batching | Cost tracking |
|---|---|---|---|---|---|---|
| **Vercel AI SDK** (`generateObject`/`streamObject`) | Zod schema → provider-native structured output (OpenAI `json_schema` strict mode, Anthropic `output_config.format`/tool-use, Gemini `responseSchema`) selected per-provider under one call shape | High — same call site, swap `model` string/provider package. Pairs with **AI Gateway** for 100+ models behind one key | Built-in: malformed output triggers automatic retry with corrective re-prompting; `NoObjectGeneratedError` exposes raw model output + response metadata for salvage/debugging instead of a bare failure | Native (`streamObject`, partial-object streaming) | No native batch API bridging — you'd still call each provider's Batch endpoint directly for bulk/backfill work | Via AI Gateway: per-model/user/tag spend dashboard, budgets that hard-stop a key, zero markup (pass-through provider pricing) |
| **Direct Anthropic SDK** | `output_config.format` (json_schema) or strict tool use; `messages.parse()` auto-validates | Low — Anthropic-specific request/response shapes; needs a hand-rolled adapter to swap providers | Strong on its own terms (schema-first, `messages.parse()`), but no cross-provider fallback | Native | Native Message Batches API, 50% off, up to 24h turnaround | None built-in; must instrument manually |
| **Direct OpenAI SDK** | `json_schema` strict mode (constrained decoding — schema conformance is close to guaranteed, not just "usually valid JSON") | Low — same lock-in problem as above | Mature, well-documented; strict mode is the production default over legacy JSON mode | Native | Native Batch API, 50% off | None built-in |
| **Instructor / BAML / PydanticAI** | Instructor: Pydantic/Zod schema wrapping a provider call with automatic validation-driven retries, multi-language (Python/TS/Go/Ruby). BAML: a DSL compiling to typed clients with "schema-aligned parsing" that recovers structured data from garbled/partial output | High (that's the point) — one schema, many providers | Instructor's retry-with-validation-feedback loop is a close analogue to AI SDK's; BAML's parser is more aggressive about recovering from bad output but requires adopting a separate DSL/build step | Instructor: partial streaming via `create_partial()`. BAML: supported | No native batching | No built-in cost dashboard |

**Recommendation: Vercel AI SDK (`generateObject`) as the calling layer**, optionally routed through **Vercel AI Gateway** for multi-provider fallback and spend visibility. Rationale:

- Atrium is already committed to Next.js/Node/TypeScript — the AI SDK is built for exactly that stack (it's a Vercel product, first-class Next.js integration, no extra runtime to operate).
- It genuinely satisfies "provider must be swappable": the interpretation-pass call site takes a Zod schema and a model identifier; changing providers or escalation tiers is a config change, not a rewrite. Direct provider SDKs don't give you that without writing the adapter layer yourself — which is exactly the kind of infrastructure `init.md` says not to build from scratch ("Custom model abstraction: No").
- AI SDK's retry/validation story (automatic retry on malformed output, `NoObjectGeneratedError` carrying the raw response instead of silently failing) is materially better than "catch a JSON.parse exception and give up," which matters at the call volume implied by "after each message."
- AI Gateway is zero-markup pass-through pricing with free observability, per-key budgets, and provider fallback baked in — it removes the need to hand-build a fallback/cost-tracking system, another item `init.md` explicitly wants reused rather than invented ("observability: reuse").
- Instructor/BAML are real alternatives worth knowing about, but they add a second dependency ecosystem (Instructor's TS port is less mature than its Python original; BAML requires adopting its own DSL and codegen step) for capability the AI SDK already covers well enough for a semantic-extraction schema of this shape. Reach for BAML specifically if the default-tier model's garbled-output rate turns out to be a real problem in practice — its schema-aligned parser is the strongest tool available for recovering from truncated/malformed JSON — but that's an escalation, not a starting point.

## 2. Model tiering: cost, latency, structured-output fit

All prices are official, per-million-token, as fetched 2026-07-31. Cost-per-1k-messages assumes **2,000 input tokens / 500 output tokens per interpretation pass** (a chat message plus recent-context window in, a small typed-object out).

| Model | Input $/MTok | Output $/MTok | Structured-output support | Cost / 1k msgs (standard) | Cost / 1k msgs (batched, 50% off) |
|---|---:|---:|---|---:|---:|
| **GPT-5.6 Luna** | $0.20 | $1.20 | Yes — `json_schema` strict mode across the GPT-5.6 family | **$1.00** | $0.50 |
| **Gemini 3.1 Flash-Lite** | $0.25 | $1.50 | Yes — `responseSchema` + `responseMimeType: application/json` | **$1.25** | $0.625 |
| Gemini 3.5 Flash-Lite | $0.30 | $2.50 | Yes | $1.85 | $0.925 |
| Claude Haiku 4.5 | $1.00 | $5.00 | Yes — `output_config.format` / strict tool use (native structured-outputs support confirmed for Haiku 4.5) | $4.50 | $2.25 |
| Gemini 3.6 Flash | $1.50 | $7.50 | Yes | $6.75 | $3.375 |
| Claude Sonnet 5 (intro, through 2026-08-31) | $2.00 | $10.00 | Yes | $9.00 | $4.50 |
| GPT-5.6 Terra | $2.00 | $12.00 | Yes | $10.00 | $5.00 |
| Gemini 3.1 Pro (≤200K prompt) | $2.00–$4.00 | $12.00–$18.00 | Yes | ~$10.00 | ~$5.00 |
| Claude Sonnet 5 (standard, from 2026-09-01) | $3.00 | $15.00 | Yes | $13.50 | $6.75 |
| Claude Opus 5 | $5.00 | $25.00 | Yes | $22.50 | $11.25 |
| GPT-5.6 Sol | $5.00 | $30.00 | Yes | $25.00 | $12.50 |

Notes on the numbers:

- **GPT-5.6 Terra just got 20% cheaper and Luna 80% cheaper on 2026-07-30** — a day before this research, per OpenAI's own pricing page. If this doc is read more than a few weeks out, re-check `developers.openai.com/api/docs/pricing` before trusting these figures.
- **Claude Sonnet 5's intro pricing ($2/$10) expires 2026-08-31** — a 50% price jump to $3/$15 the next day. Any cost model built against Sonnet 5 today should budget for the September rate, not the current one, if Atrium expects to be running past that date (likely, given it's pre-launch).
- Every provider here (Anthropic, OpenAI, Gemini) offers a **Batch API at a flat 50% discount** — turnaround up to ~24h, not usable for the live per-message pass but directly applicable to backfill/reprocessing (see §4).
- Structured-output *reliability*, not just availability, differs by mechanism: OpenAI's strict `json_schema` mode uses constrained decoding, so schema conformance is closer to guaranteed than "usually correct JSON"; Anthropic's `output_config.format` and strict tool use work the same way; Gemini's `responseSchema` is described by Google as guaranteeing parse + shape when both `responseSchema` and `responseMimeType` are set. All three are viable for a validate-then-retry loop; none of them is meaningfully worse for a well-specified, moderate-complexity extraction schema like Atrium's (decision/commitment/open-question/claim + confidence + provenance).

## 3. Recommendation

**Calling layer:** Vercel AI SDK `generateObject` with Zod schemas, called through **Vercel AI Gateway** for provider routing, automatic fallback, and free spend observability (zero markup — you pay the provider's list price either way).

**Two-tier model strategy:**

- **Default pass (every message):** **GPT-5.6 Luna** ($1.00/1k messages standard, $0.50/1k batched). It's the cheapest model on the market with strict structured-output support and is explicitly the "mundane, effectively free" tier in the routing guidance Atrium's own team already uses for other work — a per-message semantic-extraction pass over a moderate schema is exactly that shape of task. Configure **Gemini 3.1 Flash-Lite** ($1.25/1k) as the first fallback in the Gateway's provider list — close in cost, a different vendor (so an OpenAI outage doesn't take down every interpretation pass), and equally capable of the same JSON-schema-constrained extraction.
- **Escalation pass (low-confidence default-tier output, ambiguous/dense messages, or messages the reducer flags for re-interpretation):** **Claude Sonnet 5** ($9.00/1k at today's intro price, $13.50/1k from 2026-09-01). Reasoning is the differentiator here, not cost — this tier exists specifically for the cases where the default model's confidence score is low or the message is doing something semantically load-bearing (superseding an earlier decision, assigning a commitment, contradicting a claim), and Sonnet 5's agentic/instruction-following strength is the better fit than a same-vendor upgrade to GPT-5.6 Terra, which is comparably priced but not differentiated on this specific "extract nuanced multi-party semantics" task the way Sonnet is. Configure GPT-5.6 Terra as the escalation-tier fallback for the same cross-vendor-outage reason as above.
- **Fallback provider (both tiers):** Gateway-level automatic fallback across at minimum two vendors per tier, so a single provider's outage degrades quality (falls to the next tier's model) rather than blocking interpretation entirely. This is a Gateway config, not application code.

**Batching strategy for rapid message bursts:**

1. **Debounce, don't batch-API.** The Batch APIs (50% off, up to 24h turnaround) are for backfill and reprocessing, not the live per-message pass — turnaround is wrong for a feature that needs to update "current state" shortly after a message lands. Instead, coalesce: when messages arrive in a tight burst (a fast back-and-forth), buffer interpretation triggers per-conversation for a few seconds and run one extraction call over the accumulated window rather than one call per message. This is cheaper (fewer round trips) and often *more* accurate, since multi-message commitments/decisions frequently span consecutive messages that read as noise in isolation.
2. **Run it as a background job, not inline with the chat write path.** `init.md` already specifies a Postgres-backed job queue as reused infrastructure — the interpretation pass belongs there, not blocking the message-send response. That decouples user-visible latency from LLM latency and gives you a natural place to apply per-conversation concurrency caps so one hot channel doesn't starve the queue for everyone else.
3. **Idempotency on the queue, not the model call.** Key jobs by message ID so a retried job (network blip, job-queue redelivery) doesn't double-interpret and double-write semantic proposals.
4. **Reserve the native Batch APIs for what they're actually good at:** nightly re-scoring of confidence values as the reducer's rules evolve, backfilling interpretation on imported historical conversations (the Phase 1 "replay an existing conversation" work `init.md` describes), or catching up after an extended outage. All three are exactly the 50%-off, latency-insensitive case the Batch APIs are built for.

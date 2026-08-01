# Research: Authentication for Phase 2 (Issue #13)

Date: 2026-07-31

## Scope

Phase 2 requires: email/password + OAuth, sessions, email verification, invitations,
organization/workspace membership, and a path to MFA. Datastore is Postgres via Drizzle ORM.
init.md explicitly forbids building auth from scratch ("Custom authentication system: No").
Self-hostable is preferred but not dogmatic — a well-scoped SaaS dependency is acceptable if the
lock-in is bounded and the integration effort is materially lower.

Candidates evaluated: Better Auth, Clerk, Auth0 (Okta), WorkOS AuthKit, Lucia, NextAuth/Auth.js,
Supabase Auth (standalone).

## Findings by candidate

### Better Auth

- **What it is**: TypeScript-native, framework-agnostic auth library (not a hosted service). You
  own the Postgres schema; Better Auth is a library that reads/writes it directly.
- **Org/invitations**: Built-in `organization` plugin generates `organization`, `member`, and
  `invitation` tables via `npx auth@latest generate`, alongside `user`, `session`, `account`,
  `verification`. Invitation flow (create org invite, accept/decline, role assignment) is native,
  not bolted on.
- **Drizzle/Postgres fit**: First-class. Official Drizzle adapter, schema generator emits
  Drizzle schema directly, runs on your own Postgres instance with no external auth service.
- **Next.js App Router**: Native support, documented server-component and route-handler
  integration; multiple 2026 starter kits (Next.js + Drizzle + Neon + Better Auth) exist.
- **MFA path**: `twoFactor` plugin (TOTP, OTP via email/SMS, backup codes, trusted devices) and a
  separate `passkey` plugin (WebAuthn). Both are official, first-party plugins, not community
  forks.
- **Self-host vs SaaS**: Fully self-hosted by construction — it's a library, there is no Better
  Auth cloud service in the request path. Zero per-seat or per-MAU cost.
- **Pricing**: Free, MIT-licensed, no usage-based billing of any kind since there's no hosted
  component.
- **Maintenance signals**: 29.4k GitHub stars, 2.8k forks, 276 open issues (active but not
  neglected at that ratio), reached v1.6 in May 2026. Actively used in production per multiple
  independent 2026 tutorials/starter kits (Vercel templates, MakerKit, dev.to walkthroughs dated
  as recently as May 2026).
- **Lock-in / migration cost**: Low. Data lives in your own Postgres tables in a schema you
  control; there's no vendor API to unwind. Migrating off Better Auth later means replacing a
  library, not exporting an account database from a third party. The main risk is being an
  early-ish (pre-2.0), fast-moving project — plugin APIs can shift between minor versions, so
  pin versions and read changelogs on upgrade.

### Clerk

- **What it is**: Fully hosted auth-as-a-service with prebuilt UI components
  (`<SignIn>`, `<OrganizationSwitcher>`, etc.).
- **Org/invitations**: Native, first-class — organizations, invitations, roles/permissions, and
  an `OrganizationSwitcher` component ship out of the box, not an enterprise add-on.
- **Drizzle/Postgres fit**: Indirect. Clerk owns the user/session/org store on its own
  infrastructure; your Postgres only holds a foreign-key reference (Clerk user ID) synced via
  webhooks. No Drizzle schema for auth itself.
- **Next.js App Router**: Excellent — middleware-based route protection is one of Clerk's
  strongest integration stories.
- **MFA**: Built-in (TOTP, SMS, backup codes) as a toggle, no extra plugin needed.
- **Self-host vs SaaS**: SaaS only. No self-host option.
- **Pricing (2026)**: Free up to 50,000 MRU (raised from 10,000 in Feb 2026), Pro at $25/mo +
  $0.02/MAU above 50k, Business $300/mo, Enterprise custom. Billing metric changed to "monthly
  retained users" (must return 24h+ after signup to count), which is more forgiving than raw MAU.
- **Maintenance signals**: Actively developed, frequent pricing/product updates through 2026,
  widely used in the Next.js ecosystem.
- **Lock-in / migration cost**: High. User identities, credentials, and org membership live
  entirely in Clerk's infrastructure. Migrating away means a full user-export/re-onboarding
  project (password resets for all users at minimum, since password hashes are typically not
  exportable). Acceptable if the team is comfortable being permanently on Clerk; expensive to
  reverse.

### Auth0 (Okta)

- **What it is**: Enterprise CIAM SaaS platform, long-established.
- **Org/invitations**: B2B "Organizations" feature matured through 2025 and is now competitive
  with WorkOS on SAML; supports unlimited orgs starting at the B2B Essentials tier.
- **Drizzle/Postgres fit**: Indirect, same pattern as Clerk — Auth0 is the source of truth for
  identity; your Postgres stores a reference ID.
- **Next.js App Router**: Supported via `@auth0/nextjs-auth0` SDK; workable but noticeably more
  config-heavy than Clerk or Better Auth for App Router idioms.
- **MFA**: Built-in, mature (TOTP, push, SMS, WebAuthn).
- **Self-host vs SaaS**: Cloud-only SaaS. Auth0 offers a "private cloud" deployment on Azure/AWS
  for enterprise contracts, but this is not self-hosting — Auth0 still operates it.
- **Pricing (2026, verified 2026-07-28)**: Free tier: 1 enterprise SSO connection, up to 25,000
  MAU, $0. B2B Essentials starts at $150/mo (3 connections bundled). B2B Professional starts at
  $800/mo (5 connections). Billing scales with login activity, which can spike unpredictably for
  a consumer-facing product.
- **Maintenance signals**: Actively maintained under Okta ownership; stable but the ecosystem
  narrative in 2026 is "mature but pricier and heavier than newer entrants" (WorkOS, Clerk).
- **Lock-in / migration cost**: High, same category as Clerk — identity data lives with Auth0.
  Migration tooling exists (Auth0 supports bulk user export) but password re-hashing/reset is
  still typically required downstream.

### WorkOS AuthKit

- **What it is**: Hosted auth service, but positioned specifically at B2B SaaS with a strong
  enterprise-SSO/directory-sync story and a genuinely generous free tier for the base
  user-management product (AuthKit).
- **Org/invitations**: Organizations are core to the product; AuthKit bundles email+password,
  social login, passkeys, MFA, magic auth, and enterprise SSO behind one integration.
- **Drizzle/Postgres fit**: Indirect, same hosted-identity pattern as Clerk/Auth0 — WorkOS is the
  source of truth, your Postgres stores references.
- **Next.js App Router**: `@workos-inc/authkit-nextjs` is purpose-built for App Router — native
  Server Components support (no client wrappers), edge-runtime compatible, automatic session
  management. One of the stronger Next.js-specific SDKs among the hosted options.
- **MFA**: Included in AuthKit's base feature set.
- **Self-host vs SaaS**: Primarily hosted SaaS; the SDK has a documented advanced code path
  (`saveSession`) for self-hosted AuthKit scenarios, but this is a secondary, less-traveled
  configuration — treat WorkOS as SaaS-first for planning purposes.
- **Pricing (2026)**: AuthKit (user management) is free for the first 1M MAU, then $2,500/mo per
  additional 1M MAU — effectively free at Atrium's scale for a long time. Enterprise SSO/
  Directory Sync (needed only if customers demand SAML/SCIM) is billed per connection: $125/mo
  for each of the first 15 connections, sliding to $50/mo at 101–200 connections. Staging
  environments are free; only production is billed.
- **Maintenance signals**: Actively developed, frequent 2026 content (App Router guide dated
  2026, npm package updated recently), well-funded, enterprise-focused company.
- **Lock-in / migration cost**: Moderate-high, same category as Clerk/Auth0 in that identity
  lives with WorkOS, but the practical cost is softened by the very generous free tier (no
  billing pressure to migrate away early) and by WorkOS's own migration tooling/positioning
  (they market against Auth0 specifically on ease of migration).

### Lucia

- **Status: dead as a library.** Lucia was deprecated in March 2025; the npm package carries an
  official deprecation notice, and the project was reframed in 2026 as an educational resource
  ("learn how to implement sessions yourself") rather than an installable library. Bug fixes and
  security updates have ceased. **Disqualified** — installing a deprecated, unmaintained auth
  library directly contradicts "do not build auth from scratch" (Lucia's own successor advice is
  literally to copy a single-file session implementation into your app, which is scratch-built
  auth by another name).

### NextAuth / Auth.js (v5)

- **What it is**: The original Next.js-native auth library, now framework-agnostic under the
  Auth.js name; v5 is a full rewrite.
- **Org/invitations**: No built-in organization/membership/invitation model. This would need to
  be built entirely on top — closer to "scratch-built" for the org piece than any competitor
  here.
- **Drizzle/Postgres fit**: Official `@auth/drizzle-adapter`, actively maintained (version
  1.11.3 as of the research date, updated within days).
- **Next.js App Router**: Good, native support (it's the App Router's long-standing default
  choice), but v5 has been in a long beta/stabilization period historically.
- **MFA**: Not built in; requires custom implementation or a community plugin.
- **Self-host vs SaaS**: Fully self-hosted library, like Better Auth. No vendor cost.
- **Pricing**: Free, open source.
- **Maintenance signals**: Actively maintained (adapter updates within the last few days of this
  research), large existing install base.
- **Lock-in / migration cost**: Low technically (your own Postgres schema), but the missing
  org/invitation/MFA primitives mean adopting Auth.js only solves the "sessions + OAuth" third of
  Phase 2's requirements — the org/invitation/MFA layer would have to be hand-built, which is
  exactly the scratch-building init.md prohibits.

### Supabase Auth (standalone / GoTrue)

- **What it is**: GoTrue, the open-source Go JWT auth service that powers Supabase, can run
  standalone outside the full Supabase stack.
- **Org/invitations**: No native multi-tenant organization support. Community pattern is to
  store `tenant_id`/`org_id` in `app_metadata` and enforce isolation via Postgres RLS — i.e.,
  organization/workspace membership must be designed and built by the team, not provided.
  Multiple 2026 sources confirm Supabase still lacks native multi-tenancy and that teams needing
  it typically pair Supabase's DB with Clerk/Auth0/WorkOS for the org layer, or build it by hand.
- **Drizzle/Postgres fit**: Good in principle (it's Postgres-native, using `auth.users` and JWT
  claims), but running GoTrue standalone outside the Supabase platform is a rarer, less-documented
  path than running full Supabase.
- **Next.js App Router**: Supported via `@supabase/ssr`, well documented — but that documentation
  assumes the full Supabase platform (Studio, Postgres, Storage, Realtime together), not
  standalone GoTrue.
- **MFA**: Supported (TOTP) within the Supabase platform.
- **Self-host vs SaaS**: Both — Supabase Cloud (hosted) or self-hosted via Docker Compose; GoTrue
  itself is open source (Apache-2.0-family) and can run alone.
- **Pricing**: Free self-hosted; Supabase Cloud has its own tiered pricing if hosted.
- **Maintenance signals**: Actively maintained as part of the broader Supabase project.
- **Lock-in / migration cost**: Low-moderate if self-hosted (own Postgres, open-source service),
  but the missing org/invitation model means — like Auth.js — this only covers part of Phase 2.
  Running standalone GoTrue also means giving up Supabase's dashboard/tooling for a
  less-traveled deployment shape, adding operational risk without buying anything Better Auth
  doesn't already give more directly in Drizzle-native form.

## Comparison table

| Candidate | Org + invitations built in | Drizzle/Postgres fit | Next.js App Router | Self-host / SaaS | Cost at small scale | Maintenance | Lock-in |
|---|---|---|---|---|---|---|---|
| **Better Auth** | Yes (org plugin: org/member/invitation tables) | Native, first-class | Native | Self-host (library) | Free | Active, v1.6 May 2026, 29.4k stars | Low — your schema, your Postgres |
| Clerk | Yes, first-class | Indirect (external store + webhook sync) | Excellent | SaaS only | Free to 50k MRU, then $25/mo+ | Active | High — identity lives with vendor |
| Auth0 | Yes, mature B2B Orgs | Indirect | Good, heavier config | SaaS only (private cloud is still vendor-run) | Free to 25k MAU, then $150/mo+ | Active, stable | High |
| WorkOS AuthKit | Yes, core to product | Indirect | Very good (purpose-built SDK) | SaaS-first (self-host path exists, secondary) | Free to 1M MAU | Active, well-funded | Moderate-high (softened by generous free tier) |
| Lucia | N/A — deprecated | N/A | N/A | N/A | N/A | **Dead (deprecated Mar 2025)** | Disqualified |
| Auth.js / NextAuth v5 | No — build it yourself | Native (official adapter, actively updated) | Good | Self-host (library) | Free | Active | Low technically, but org/MFA gap = scratch-build risk |
| Supabase Auth (standalone) | No — build it yourself (RLS pattern) | Good in principle, less-traveled standalone path | Good (assumes full platform) | Both | Free self-hosted | Active | Low-moderate, same org-gap problem |

## Recommendation

**Primary: Better Auth.**

It is the only candidate that satisfies the full Phase 2 feature list (email/password, OAuth,
sessions, email verification, invitations, organization/workspace membership, MFA path) as
first-party, actively maintained functionality, while staying fully self-hosted on the project's
existing Drizzle/Postgres stack with no per-seat or per-MAU billing and no external identity
store to reconcile against application data. It satisfies init.md's "do not build auth from
scratch" constraint precisely — it is an established, actively maintained library, not a
hand-rolled session system — while keeping lock-in low: the auth tables are ordinary rows in
Atrium's own Postgres database, generated by Better Auth's own schema tooling, so migrating away
later is a library swap, not a data-export negotiation with a vendor. The main risk to manage is
that Better Auth is a fast-moving, pre-2.0-in-spirit project (frequent minor releases, plugin API
churn) — mitigate by pinning versions and reviewing changelogs on upgrade, and by writing an
integration test suite around the auth flows so upgrades are caught by CI rather than discovered
in production.

Integration effort estimate for the Phase 2 list: **roughly 1-1.5 weeks** for a developer
already familiar with Drizzle — schema generation and email/password + OAuth (GitHub/Google) is a
1-2 day task per Better Auth's own quickstart; the `organization` plugin adds invitations and
membership in another 1-2 days including UI; the `twoFactor`/`passkey` plugins for the MFA path
are additive and can land in a follow-up slice without touching the core schema. This is
materially faster than Auth.js/Supabase (where the org/invitation/MFA layer would need to be
designed and built from scratch, likely 2-3x the effort) and comparable in speed to Clerk/WorkOS
integration, but without their ongoing vendor dependency.

**Fallback: WorkOS AuthKit.**

If the team later decides the operational burden of self-managing auth (patching, session store
scaling, security review surface) outweighs the lock-in cost — or if Atrium's Phase 2+ roadmap
leans hard into enterprise customers who demand SAML SSO/SCIM directory sync as a sales
requirement — WorkOS is the strongest fallback. It has the most generous free tier of any hosted
option (1M MAU free), the most Next.js-App-Router-native SDK among the SaaS options, org support
that's core rather than bolted on, and per-connection enterprise-SSO pricing that only kicks in
when a customer actually needs SAML (rather than taxing the whole user base for a feature most
users won't use). It is not self-hosted by default, so it reintroduces the lock-in Better Auth
avoids, but the migration story is softened by the free tier buying time to reconsider, and WorkOS
explicitly markets easier exit/migration than Auth0. Clerk and Auth0 were both considered and
rejected as the fallback: Clerk's pricing is comparable to WorkOS but with a smaller free
ceiling and no meaningful self-host escape hatch, and Auth0 is the most expensive and heaviest
to integrate of the SaaS options for a team this size.

Lucia is disqualified outright (deprecated since March 2025, no security updates). Auth.js/
Supabase Auth standalone are disqualified as primary because neither provides the
organization/invitation/MFA layer Phase 2 needs — adopting either would mean hand-building
exactly the "custom authentication system" init.md prohibits for the parts that matter most to
Phase 2 (org membership and invitations).

## Sources

- [Full Stack Authentication in 2026 with Better Auth, Drizzle, Neon, Shadcn UI, and Next.js](https://dev.to/iampandit/full-stack-authentication-in-2026-with-better-auth-drizzle-neon-shadcn-ui-and-nextjs-32nb) (2026)
- [Full Stack Authentication in 2026: Next.js, Better Auth, and Drizzle ORM](https://earezki.com/ai-news/2026-05-08-full-stack-authentication-in-2026-with-better-auth-drizzle-neon-shadcn-ui-and-nextjs/) (2026-05-08)
- [Next.js Drizzle - Authentication Configuration (MakerKit)](https://makerkit.dev/docs/nextjs-drizzle/better-auth/overview)
- [Better Auth vs Clerk vs NextAuth vs Supabase Auth: Which Authentication for Next.js SaaS in 2026](https://makerkit.dev/blog/tutorials/better-auth-vs-clerk)
- [Better Auth GitHub repository](https://github.com/better-auth/better-auth) (fetched 2026-07-31; 29.4k stars, 2.8k forks, 276 open issues, MIT license, v1.6 as of May 2026)
- [Two-Factor Authentication (2FA) — Better Auth docs](https://better-auth.com/docs/plugins/2fa)
- [Passkey — Better Auth docs](https://better-auth.com/docs/plugins/passkey)
- [Clerk Pricing 2026: Plans, Costs & Cost Calculator](https://checkthat.ai/brands/clerk/pricing)
- [Clerk vs Better Auth (2026) — We Verified Every Price So You Don't Have To](https://dev.to/thiago_alvarez_a7561753aa/clerk-vs-better-auth-2026-we-verified-every-price-so-you-dont-have-to-13pk)
- [Pricing Changes for Auth0 by Okta](https://auth0.com/blog/upcoming-pricing-changes-for-the-customer-identity-cloud/)
- [Enterprise Authentication Pricing 2026: What WorkOS, Auth0, and Okta Actually Charge](https://ssojet.com/blog/enterprise-authentication-pricing-2026) (verified pricing as of 2026-07-28)
- [Auth0 vs Okta vs Stytch vs WorkOS vs SSOJet (2026): A Buyer-Stage Framework](https://securityboulevard.com/2026/06/auth0-vs-okta-vs-stytch-vs-workos-vs-ssojet-2026-a-buyer-stage-framework/) (2026-06)
- [Top Open-Source Auth0 Alternatives in 2026](https://www.authgear.com/post/top-open-source-auth0-alternatives/) (Auth0 is cloud-only SaaS, no self-host)
- [WorkOS Pricing](https://workos.com/pricing.md)
- [WorkOS Pricing Explained (2026): Free 1M Users & Per-Connection Costs](https://idsync.com/guides/workos-pricing)
- [WorkOS vs. BetterAuth vs. Clerk: Which should you choose?](https://workos.com/blog/workos-vs-betterauth-vs-clerk)
- [Building authentication in Next.js App Router: The complete guide for 2026 — WorkOS](https://workos.com/blog/nextjs-app-router-authentication-guide-2026)
- [AuthKit Next.js SDK – WorkOS Docs](https://workos.com/docs/sdks/authkit-nextjs)
- [Lucia Auth is Dead - What's Next for Auth?](https://www.wisp.blog/blog/lucia-auth-is-dead-whats-next-for-auth) (deprecation announced March 2025, confirmed current as of 2026)
- [Lucia homepage](https://lucia-auth.com/) (reframed 2026 as educational resource, package deprecated on npm)
- [Auth.js | Drizzle Adapter](https://authjs.dev/reference/drizzle-adapter)
- [next-auth/packages/adapter-drizzle — GitHub](https://github.com/nextauthjs/next-auth/blob/main/packages/adapter-drizzle/src/index.ts) (adapter at v1.11.3, updated within days of research date)
- [Self-Hosting | Supabase Docs](https://supabase.com/docs/reference/self-hosting-auth/introduction)
- [GitHub - supabase/auth (GoTrue)](https://github.com/supabase/auth)
- [Supabase: Support Multi-Tenancy With Detail + Template Project](https://medium.com/@itsuki.enjoy/supabase-support-multi-tenancy-with-detail-template-project-34f3a3d97ee4) (2026-03, confirms no native multi-tenancy)
- [Multi-tenant — supabase GitHub Discussion #1615](https://github.com/orgs/supabase/discussions/1615)

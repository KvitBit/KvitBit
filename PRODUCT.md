# Product

<!-- impeccable:product-schema 1 -->

## Platform

adaptive

## Users

Czech and EU freelancers (OSVČ), small-to-medium company operators (s.r.o.), their team members, and external accountants who issue invoices, track expenses, and monitor cashflow and VAT across desktop browsers and Android phones.

Secondary audience: recipients opening tokenized Public Share Links on mobile or desktop browsers to pay an invoice (via QR Platba or EPC QR) and download the PDF, plus AI agents acting on a Member's behalf through remote Streamable HTTP MCP.

## Product Purpose

Provide a Facturoid-class invoicing and expense management application (`kvitbit`) that covers the complete Czech and EU issuing lifecycle (Regular Invoices, Proformas, Payment Tax Documents, Credit Notes, Final Invoices, Invoice Templates, Recurring Schedules, Expenses, Contacts with ARES lookup, Price List, Payments, Reports, PDFs, and Resend email delivery) as both a free public multi-tenant SaaS on a single host and a clean self-hostable deployment.

Success means an operator can issue a compliant CZ/EN invoice in seconds from desktop, phone, or MCP without accounting friction, track payments and expenses accurately across currencies, and trust every number and audit record.

## Positioning

Combines full Czech/EU statutory invoicing compliance (all three Czech tax regimes, ARES lookup, CNB daily FX rates, CZK SPAYD QR Platba + EUR EPC QR) with an interface-first hexagonal architecture delivering full feature parity across four native adapters: a Foldkit (Effect 4.1 TEA) web app, an Expo Android APK and `/app/` PWA, an Effect `HttpApi` REST API, and an OAuth 2.1 remote MCP server, deployable both on GCP (Alchemy + Effect Cluster/Workflow + Neon) and self-hosted via Nix flake or Docker.

## Operating Context

- **Desktop web**: Daily ledger management, multi-line invoice and expense editing, numbering series, templates and recurring schedules, VAT and cashflow reports, team/settings administration.
- **Phone (Expo Android APK + `/app/` PWA)**: Full feature parity, with phone-first speed for receipt camera/PDF expense capture, quick invoicing from templates, payment recording, Public Share Link sharing, Workspace switching, and passkey sign-in.
- **Public web**: Fast SSR landing, Czech and English Terms/Privacy Policy, `/android` APK/Obtainium download page, and phone-first tokenized Public Share Link invoice view.
- **MCP**: Two-step preview-then-confirm issuing/sending and single-call reads, drafts, lookups, and payment logging.

## Capabilities and Constraints

- `1 Workspace = 1 Issuing Entity` with fast Workspace switching and four roles (`owner`, `admin`, `member`, `accountant`).
- All three Czech tax regimes (`non_vat_payer`, `vat_payer`, `identified_person`), multi-currency with CNB daily FX rates, per-rate-bucket VAT rounding, and Czech + English UI, PDFs, and emails.
- Facturoid permissive editing: drafts freely editable/deletable; issued documents editable with full audit history until manually locked; never hard-deleted (Credit Note / Storno); soft-delete Workspace/account for 10-year tax retention.
- Zero third-party SaaS CAPTCHA: self-hosted ALTCHA PoW v2 behind `BotProtection`.
- Components built on `@ui-sdk/core` (+ `@foldkit/ui` on web, native React Native primitives on Expo).
- Out of scope in v1: Fio Bank automatic payment matching, quotes/estimates, Czech accounting XML exports (ISDOC, Pohoda, DPH/KH XML), paid subscriptions/Stripe, OCR/email-inbox expense ingestion, per-workspace custom Resend domains.
- Far-out roadmap candidates (post-v1): optional local/self-hosted receipt and invoice extraction (e.g., GLM-OCR behind an extraction port) to prefill Expense fields from uploaded attachments.

## Brand Commitments

- Name: Kvitbit (package and identifier form `kvitbit`), from the Czech "jsme kvit" (we are square, nothing owed) plus binary "bit". Domains: `kvitbit.cz`, `kvitbit.app`.
- Infra IDs bootstrapped before the rename stay unchanged: GitHub repo `totalolage/invoicarr`, GCP project `invoicarr-prod`, Neon project `hidden-hall-00717862` (see ADR 0003).
- Visual identity is locked: N2 Dual-Bit Notch mark, Clash Display Semibold wordmark, T4 Micro-Glyph Graph pattern. The full brand kit is in `assets/brand/`, `assets/icon.svg` is the N2 light mark, and the rules are in `DESIGN.md` (Brand Identity).
- Full light and dark mode support required, with crisp tabular numerals for Czech/EU monetary values.
- Full bilingual Czech and English copy.

## Evidence on Hand

- Domain glossary: `CONTEXT.md`
- Approved end-to-end flow map: `docs/design/user-flows.md`
- Primary-source Czech legal/VAT/ARES/CNB/SPAYD specs: `docs/research/czech-invoicing-specs.md`
- Settled architecture decisions: `docs/adr/0001-foldkit-web-adapter.md`, `0002-altcha-pow-bot-protection.md`, `0003-alchemy-gcp-neon-cluster-and-nix-self-hosting.md`
- Absences (must not be fabricated): no customer testimonials, no live user metrics, no paid pricing tiers, and no final operator legal entity name yet (shipped as configurable EN/CZ legal templates).

## Product Principles

1. **Numbers first, never ambiguous**: Monetary totals, VAT recaps, currencies, FX rates, due dates, and payment states must scan instantly with tabular alignment and zero visual clutter.
2. **Full parity, context-aware ergonomics**: Desktop and mobile share the exact same domain capabilities (`packages/ui-port`), while phone flows optimize capture, sharing, and quick actions for thumb reach.
3. **Permissive speed with auditable safety**: Issuing and editing stay fast like Facturoid, while audit history, manual Document Lock, and two-step MCP confirmation protect accounting integrity.
4. **Honest bilingual craft**: Czech and English are co-equal first-class locales across UI, PDFs, and emails, respecting longer Czech labels and Czech statutory wording.

## Accessibility & Inclusion

- Target WCAG 2.1 AA contrast in both light and dark modes across Web and Mobile.
- Support keyboard navigation, visible focus states, reduced motion (`prefers-reduced-motion`), and 200% font scaling / 360 dp mobile layout resilience (matching `deskohub-mobile` discipline).

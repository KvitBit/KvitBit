# Web adapter research: TanStack Start vs Foldkit

Read: 2026-11-22. Scope: the stated Kvitbit requirements for an `/app` web adapter backed by the existing Effect `HttpApi` service. This is a source-based architecture comparison, not an implementation spike.

## Recommendation

Choose **TanStack Start (React)** for the web adapter. It is the better fit for existing `@ui-sdk/react` usage, rich DOM screens, Better Auth integration, route-level SSR, and official Bun hosting guidance. Keep Effect `HttpApi` as the backend that owns `/api`, `/mcp`, and `/api/auth`; have the web app render under `/app` and call that contract.

Foldkit is now aligned with Effect 4.1 and has real routing, TEA, and SSR features, but it is a poor greenfield bet for this adapter at this moment: its SSR export is explicitly experimental, and the maintainer announced a foundation rebuild with feature development paused and a required migration that may include substantial API changes. Reconsider Foldkit after the new foundation and stable SSR contract ship.

## Evidence matrix

| Concern | TanStack Start (React) | Foldkit (Effect + TEA) | Assessment for Kvitbit |
|---|---|---|---|
| Effect 4.1 | Start is a React framework; it does not make Effect its app architecture. Effect can remain in the backend/shared TS packages. | Foldkit 0.170 upgraded Foldkit and companion packages to Effect 4.1; ranges allow 4.1 patches. | Foldkit wins direct Effect integration. This is not a backend blocker: the required Effect `HttpApi` stays behind HTTP either way. |
| UI SDK | Official `@ui-sdk/react` adapter, each component entry, React 19+ installation; core is its behavior package. UI SDK itself is beta. | UI SDK documents React/Vue/Svelte/Solid/Web Components adapters, not Foldkit. Foldkit has its own HtmlBuilder/runtime and `@foldkit/ui`; its examples show mounting custom elements, so `@ui-sdk/web` could be explored, but is not a native adapter. | TanStack has the shortest, lowest-risk path to existing React UI SDK components. Treat a Foldkit/core binding as custom integration work. The local deskohub package paths were absent in this workspace, so no installed export surface was inspected. |
| SSR, routing, metadata | TanStack Start is documented stable, with full-document SSR, loaders, selective SSR, server entry, file-based typed routing and a router `basepath`. | Foldkit has typed routing and SSG/SSR, but SSR is currently under `foldkit/experimental/server`, not broadly production-exposed; it renders one shared Model/view on server and browser. | Both can serve landing/legal/download/share routes. TanStack has the stronger stability signal for public tokenized invoice SSR. Foldkit docs explicitly advise pinning SSR and testing upgrades. |
| Interactive financial UI | React supports controlled editor state and established React components/libraries; the UI SDK React adapter is directly usable. | TEA makes every editor transition and effect explicit; Foldkit ships headless controls and Commands/Subscriptions. | Foldkit is architecturally attractive for VAT/editor state, but its interaction model demands custom component integration and domain-specific screen composition. React has lower integration cost for comboboxes, tables, date pickers, sheets and dialogs. |
| Shared Expo contract | Share schemas, API clients, pure VAT/presenter calculations and validation in TS packages. React DOM components and `@ui-sdk/react` are not automatically React Native components; use separate web/native renderers. Better Auth documents an Expo client integration. | Share TEA Model/update logic only if a native rendering/runtime adapter is built; current view contract is HTML/DOM-oriented. The announced future foundation aims at multiple rendering environments, but is not shipped. | Neither currently gives one native-and-web renderer. Define a portable presenter/domain contract and build React DOM + React Native views separately. TanStack is the practical route for that contract today. |
| Auth, passkeys, PoW | Better Auth has a TanStack Start integration and `tanstackStartCookies`; its passkey plugin is a framework-independent WebAuthn server/client plugin. | No Foldkit-specific Better Auth integration found. A browser client can still call the shared auth API; this is custom wiring. | Since `/api/auth` belongs to the dedicated backend, keep auth handling there and configure clients to use the same-origin route. Passkey ceremonies are browser/device behavior, not a framework differentiator. ALTCHA is a self-hosted OSS PoW option, but Better Auth's documented captcha providers do not include ALTCHA; verify PoW at an API/auth boundary or add a custom integration. |
| CZ + EN | Router docs show SSR i18n with Paraglide, locale middleware and `<html lang>`. | Can set document `lang`; no Foldkit i18n framework integration was found in the reviewed docs. | Both can support Czech/English with a shared translation layer. Match server/client locale and timezone for currency/date hydration; TanStack documents this exact SSR mismatch risk. |
| Bun, Docker, Nix, Alchemy/GCP | Official TanStack docs cover Bun runtime hosting via Nitro preset or custom Bun server (Bun path currently requires React 19+). | Foldkit SSR docs describe a Web `fetch` handler and Node/Workers; the standard host is `@foldkit/node` and requires Node 22.19+ for current tooling. No official Bun host guide was found. | TanStack has the clearest route to a Bun image. Docker/Nix and Alchemy/GCP are infrastructure choices rather than native framework integrations; compose the SSR handler with the existing API dispatcher and verify the exact GCP artifact/start command. |
| Maturity and risks | Official docs call Start stable. RSC remains experimental and is unnecessary for this use. React ecosystem is broad. | Latest docs show Foldkit 0.171.0, still pre-1.0. New foundation work pauses feature development; existing apps will need migration, some changes substantial. | TanStack is the lower-change-risk option. Foldkit's current API could be compelling later, but the announced migration overlaps with the lifetime of a new Kvitbit UI adapter. |

## Integration shape and pitfalls

- Configure the web router with `/app` as its base path. Put one outer Bun request dispatcher in front: route `/api`, `/mcp`, and `/api/auth` to the Effect service and `/app/*` to the TanStack Start fetch handler. TanStack's server entry accepts Web `Request`/`Response`; its router supports a `/app` base path. This composition is an architectural inference and should be proven in a small deploy spike, especially URL rewriting, assets, cookies, and trailing-slash behavior.
- Render tokenized invoice share pages from a server loader using the public share token, and derive title, description, canonical URL, and Open Graph metadata from the same response. Avoid exposing authenticated invoice data or bearer credentials to the client. Keep private editor routes selectively SSR/client-oriented as appropriate.
- TanStack loaders are isomorphic; use a server function/server-only boundary for server-only secrets and pass a safe DTO to the route. Keep the locale/timezone deterministic between SSR and hydration to avoid date/VAT formatting mismatches.
- Keep shared code intentionally portable: Effect schemas/domain logic/presenter DTOs and exact money/VAT calculations can be reused by the web and Expo apps; web controls, focus management, date pickers, sheets and navigation need renderer-specific implementations.
- Foldkit does not appear to use or expose Snabbdom as its adapter contract in the reviewed sources. Its documented contract is `HtmlBuilder`/`Document`, `Runtime`, and browser DOM helpers. The viable UI SDK route would be a custom core binding or custom-element adapter, with Foldkit view/rehydration interactions left to validate.

## Sources

Primary sources, all read 2026-11-22:

- Foldkit Effect 4.1 and release state: [Foldkit 0.171.0](https://foldkit.dev/blog/foldkit-0-171-0)
- Foldkit migration and feature pause announcement: [Foldkit Joins Effect](https://foldkit.dev/blog/foldkit-joins-effect)
- Foldkit SSR lifecycle and experimental status: [Server Rendering](https://foldkit.dev/core/server-rendering)
- Foldkit UI peers: [@foldkit/ui README](https://github.com/foldkit/foldkit/blob/main/packages/ui/README.md); custom element example: [create-foldkit-app examples](https://github.com/foldkit/foldkit/blob/main/packages/create-foldkit-app/README.md)
- TanStack status/SSR: [Start overview](https://tanstack.com/start/latest/docs/framework/react/overview), [Selective SSR](https://tanstack.com/start/latest/docs/framework/react/guide/selective-ssr), [Server Entry Point](https://tanstack.com/start/latest/docs/framework/react/guide/server-entry-point)
- TanStack `/app` base path: [RouterOptions `basepath`](https://tanstack.com/router/latest/docs/api/router/RouterOptionsType)
- UI SDK adapters and beta status: [Core introduction](https://ui-sdk.dev/docs/core), [React installation](https://ui-sdk.dev/docs/react/installation), [Web Components](https://ui-sdk.dev/docs/web-components)
- Better Auth integration: [TanStack Start](https://better-auth.com/docs/integrations/tanstack), [Passkey](https://better-auth.com/docs/plugins/passkey), [Expo](https://better-auth.com/docs/integrations/expo)
- i18n and hydration: [TanStack i18n guide](https://tanstack.com/router/latest/docs/guide/internationalization-i18n), [Hydration Errors](https://tanstack.com/start/latest/docs/framework/react/guide/hydration-errors)
- Bun: [TanStack Start hosting](https://tanstack.com/start/latest/docs/framework/react/guide/hosting), [Bun TanStack Start guide](https://bun.sh/guides/ecosystem/tanstack-start)
- OSS PoW: [ALTCHA introduction](https://altcha.org/docs/), [PoW integration](https://altcha.org/docs/integration/proof-of-work-captcha/); Better Auth captcha providers: [Captcha plugin v1.6 docs](https://better-auth.com/docs/1.6/plugins/captcha)

## Not verified

- The two supplied local `@ui-sdk/core/package.json` locations did not exist in this checkout; the report uses current public UI SDK docs instead.
- No official Foldkit UI SDK adapter, Foldkit-specific Better Auth integration, Foldkit Bun host, Nix flake recipe, or Alchemy/GCP recipe was located in the sources reviewed. This records a bounded search result, not proof that community integrations do not exist.
- No executable SSR/router-composition or bundle/deploy spike was run; the suggested same-process dispatcher needs validation against Kvitbit's actual build and hosting layout.

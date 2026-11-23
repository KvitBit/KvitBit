# Use Foldkit (Effect 4.1 + TEA) for the web adapter

We chose **Foldkit (`0.171.x`, Effect 4.1 + The Elm Architecture)** over TanStack Start for `apps/web` because the team explicitly accepts experimental/unstable packages in exchange for pure Effect 4.1 end-to-end and a Model/Message/Update state architecture that aligns directly with `packages/ui-port`.

## Considered Options

- **TanStack Start (React)**: Stable SSR, official `@ui-sdk/react`, official Better Auth and Paraglide SSR guides, native Bun hosting, but splits the web UI away from Effect TEA.
- **Foldkit (`0.171.x`)**: Pure Effect 4.1 Model/Message/Update/Command across the web adapter with `@foldkit/ui` and experimental SSR, requiring custom `@ui-sdk/core` / `@ui-sdk/web` bindings and custom Better Auth client wiring, plus accepting an upcoming maintainer foundation rebuild.

## Consequences

- `packages/ui-port` models screen state, messages, and pure transitions using Effect Schema so Foldkit renders them directly on web and Expo React Native adapts the same contracts on mobile.
- `@ui-sdk/core` behaviors (and `@ui-sdk/web` custom elements where helpful) pair with `@foldkit/ui` rather than `@ui-sdk/react`.
- `apps/server` (Bun + Effect `HttpApi`) owns `/api`, `/mcp`, `/api/auth`, and `/app/` (Expo PWA static export), keeping auth and domain seams decoupled from Foldkit's SSR runtime.

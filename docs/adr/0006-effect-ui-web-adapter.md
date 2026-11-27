# Use Effect UI for the web adapter

Accepted 2026-11-26. Supersedes [ADR-0001](0001-foldkit-web-adapter.md).

Foldkit development moved to Effect UI. We use Effect UI in `apps/web` to keep
Schema-backed models and messages, pure updates, and Effect services on the
web. The application keeps the shared URL and permission contracts in
`packages/ui-port`. [Effect UI repository](https://github.com/Effect-TS/ui)

## Application structure

The shell owns the current route, session, workspace membership, and viewer
preferences. It checks access before rendering a page and refreshes session
and membership data before following a post-authentication destination. Each
page owns its model and commands. Its key includes the route URL, so leaving
a page closes its command scope. Request sequence checks still guard multiple
loads within one page.

Invited signup pairs with the reviewed Phase 3A invitation signup handler.
The web request includes the invitation token and an `invitation_accept`
proof. After the handler sets the verified session cookie, the web client
accepts the invitation and refreshes workspace membership before navigating.
Ordinary email signup uses a `sign_up` proof.

`BrowserRouter` owns link interception and browser history. The mobile app
under `/app/` and endpoints under `/api/` use native browser navigation.
Public PDF links use download anchors. Views emit native HTML. Chart labels
are text and attributes. Brand marks and payment QR codes are images.

Vite emits the static web entry at base `/` with hashed bundles, brand
assets, and fonts. The browser entry uses `BrowserHost.mount` on that entry
and `HtmlHydrate.hydrate` when supplied with `HtmlServer.renderToHtml` output
and its state. The Tier 2 checks exercise both paths. [Verification policy](0005-formal-verification.md)

## Package pin

The web adapter pins `@effect/ui` to commit
`5f8b3576288a5aa3e69eaa8def155b17c76f1776` using the upstream
`pkg.pr.new` snapshot URL. The spike installed and rendered with Effect
4.1.4, Bun 1.4.2, TypeScript 6.0.2, and Vite 8.3.8. Chromium adopted and
updated a server-rendered node. [Pinned package](https://pkg.pr.new/Effect-TS/ui/@effect/ui@5f8b357)

The pin keeps installs reproducible while the API is experimental. Builds
depend on the snapshot host until an npm release is available. When upstream
publishes a compatible 0.1 or 1.0 release, update the package pin and lockfile
together. Rerun the web checks, including hydration, navigation, and the
static artifact check, before removing the snapshot pin.

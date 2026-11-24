/**
 * Kvitbit brand rendering (DESIGN.md "Brand Identity"). The N2 mark ships as two optical masters:
 * the light master (10-unit gaps) for dark ink on light surfaces and the dark master (14-unit gaps)
 * for light ink on dark surfaces. The master follows the surface, so both are rendered and CSS shows
 * the one matching the active scheme (`.kb-only-light` / `.kb-only-dark`). K4 lockups are the
 * committed path-only SVGs; the wordmark is never retyped in a font.
 */
import { markSvg } from "@kvitbit/brand";
import type { Html, HtmlBuilder } from "foldkit/html";

const inline = (master: "light" | "dark"): string =>
  markSvg({ master, fill: "currentColor", title: "Kvitbit" })
    .replace(' aria-labelledby="title"', ' aria-hidden="true" focusable="false"')
    .replace(/<title id="title">[^<]*<\/title>\s*/, "");

const MARK_LIGHT = inline("light");
const MARK_DARK = inline("dark");

/** The mark alone (minimum 16px). `size` sets the rendered square in px. */
export const mark = <M>(h: HtmlBuilder<M>, size = 28, label = "Kvitbit"): Html =>
  h.span(
    [
      h.Class("kb-mark"),
      h.Role("img"),
      h.AriaLabel(label),
      h.Style({ "--kb-mark-size": `${size}px` }),
    ],
    [
      h.span([h.Class("kb-only-light"), h.InnerHTML(MARK_LIGHT)]),
      h.span([h.Class("kb-only-dark"), h.InnerHTML(MARK_DARK)]),
    ],
  );

const lockupSrc = (layout: "horizontal" | "stacked", master: "light" | "dark") =>
  `/assets/brand/lockup/kvitbit-lockup-${layout}-${master}.svg`;

/**
 * K4 lockup. Horizontal minimum 16px tall, stacked minimum 48px tall; clear space (2u) is the
 * wrapper padding. Below the horizontal minimum use `mark` instead.
 */
export const lockup = <M>(
  h: HtmlBuilder<M>,
  layout: "horizontal" | "stacked" = "horizontal",
  height = layout === "horizontal" ? 22 : 64,
): Html =>
  h.span(
    [h.Class(`kb-lockup kb-lockup--${layout}`), h.Style({ "--kb-lockup-height": `${height}px` })],
    [
      h.img([
        h.Class("kb-only-light"),
        h.Src(lockupSrc(layout, "light")),
        h.Alt("Kvitbit"),
        h.Height(String(height)),
      ]),
      h.img([
        h.Class("kb-only-dark"),
        h.Src(lockupSrc(layout, "dark")),
        h.Alt("Kvitbit"),
        h.Height(String(height)),
      ]),
    ],
  );

import type { Html } from "@effect/ui/html";
/**
 * Kvitbit brand rendering (DESIGN.md "Brand Identity"). The N2 mark ships as two optical masters:
 * the light master (10-unit gaps) for dark ink on light surfaces and the dark master (14-unit gaps)
 * for light ink on dark surfaces. The master follows the surface, so both are rendered and CSS shows
 * the one matching the active scheme (`.kb-only-light` / `.kb-only-dark`). K4 lockups are the
 * committed path-only SVGs; the wordmark is never retyped in a font.
 */
import type { Markup } from "./html";

const MARK_LIGHT = "/assets/brand/kvitbit-mark-current-light.svg";
const MARK_DARK = "/assets/brand/kvitbit-mark-current-dark.svg";

/** The mark alone (minimum 16px). `size` sets the rendered square in px. */
export const mark = <M>(h: Html.H<M>, size = 28, label = "Kvitbit"): Markup<M> =>
  h.span
    .class("inline-flex [&_img]:h-[var(--kb-mark-size,28px)] [&_img]:w-[var(--kb-mark-size,28px)]")
    .attr("role", "img")
    .attr("aria-label", label)
    .style({ "--kb-mark-size": `${size}px` })
    .children([
      h.img.class("kb-only-light").attr("src", MARK_LIGHT).attr("alt", ""),
      h.img.class("kb-only-dark").attr("src", MARK_DARK).attr("alt", ""),
    ]);

const lockupSrc = (layout: "horizontal" | "stacked", master: "light" | "dark") =>
  `/assets/brand/lockup/kvitbit-lockup-${layout}-${master}.svg`;

/**
 * K4 lockup. Horizontal minimum 16px tall, stacked minimum 48px tall; clear space (2u) is the
 * wrapper padding. Below the horizontal minimum use `mark` instead.
 */
export const lockup = <M>(
  h: Html.H<M>,
  layout: "horizontal" | "stacked" = "horizontal",
  height = layout === "horizontal" ? 22 : 64,
): Markup<M> =>
  h.span
    .class("inline-flex items-center p-1 [&_img]:h-[var(--kb-lockup-height,22px)] [&_img]:w-auto")
    .style({ "--kb-lockup-height": `${height}px` })
    .children([
      h.img
        .class("kb-only-light")
        .attr("src", lockupSrc(layout, "light"))
        .attr("alt", "Kvitbit")
        .attr("height", String(height)),
      h.img
        .class("kb-only-dark")
        .attr("src", lockupSrc(layout, "dark"))
        .attr("alt", "Kvitbit")
        .attr("height", String(height)),
    ]);

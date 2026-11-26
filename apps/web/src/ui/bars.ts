import type { Html } from "@effect/ui/html";
import type { Markup } from "./html";

export type BarTone = "primary" | "secondary" | "overdue";
export interface BarGroup {
  readonly label: string;
  readonly bars: ReadonlyArray<{ readonly value: number; readonly tone: BarTone }>;
}

export const barChart = <M>(
  h: Html.H<M>,
  label: string,
  groups: ReadonlyArray<BarGroup>,
): Markup<M> => {
  const maximum = Math.max(
    1,
    ...groups.flatMap((group) => group.bars.map((bar) => Math.abs(bar.value))),
  );
  return h.div
    .class("kb-bar-chart")
    .attr("role", "img")
    .attr("aria-label", label)
    .children(
      groups.map((group) =>
        h.div.class("kb-bar-chart__group").children(
          h.div.class("kb-bar-chart__plot").children(
            group.bars.map(({ value, tone }) =>
              h.span
                .class("kb-bar-chart__bar", `kb-bar-chart__bar--${tone}`)
                .attr("title", `${group.label}: ${value}`)
                .style({ height: `${(Math.abs(value) / maximum) * 100}%` }),
            ),
          ),
          h.span.class("kb-bar-chart__label").attr("title", group.label).children(group.label),
        ),
      ),
    );
};

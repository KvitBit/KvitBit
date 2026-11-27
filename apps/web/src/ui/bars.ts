import type { Html } from "@effect/ui/html";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import type { Markup } from "./html";

type BarTone = "primary" | "secondary" | "overdue";
export interface BarGroup {
  readonly label: string;
  readonly bars: ReadonlyArray<{ readonly value: number; readonly tone: BarTone }>;
}

const barChartImpl = <M>(
  h: Html.H<M>,
  label: string,
  groups: ReadonlyArray<BarGroup>,
): Markup<M> => {
  const maximum = Math.max(
    1,
    ...Arr.flatMap(groups, (group) => Arr.map(group.bars, (bar) => Math.abs(bar.value))),
  );
  return h.div
    .class("kb-bar-chart")
    .attr("role", "img")
    .attr("aria-label", label)
    .children(
      Arr.map(groups, (group) =>
        h.div.class("kb-bar-chart__group").children(
          h.div.class("kb-bar-chart__plot").children(
            Arr.map(group.bars, ({ value, tone }) =>
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

export const barChart: {
  <M>(label: string, groups: ReadonlyArray<BarGroup>): (h: Html.H<M>) => Markup<M>;
  <M>(h: Html.H<M>, label: string, groups: ReadonlyArray<BarGroup>): Markup<M>;
} = Fn.dual(3, barChartImpl);

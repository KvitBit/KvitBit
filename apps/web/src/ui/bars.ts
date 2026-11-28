import type { Html } from "@effect/ui/html";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import type { Markup } from "./html";
import { barToneVariants } from "./styles";

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
    .class("grid h-32 auto-cols-[minmax(0,1fr)] grid-flow-col gap-1")
    .attr("data-slot", "bar-chart")
    .attr("role", "img")
    .attr("aria-label", label)
    .children(
      Arr.map(groups, (group) =>
        h.div.class("grid min-w-0 grid-rows-[1fr_auto] text-center").children(
          h.div
            .class("flex min-h-24 items-end justify-center gap-0.5 border-b border-outline-variant")
            .children(
              Arr.map(group.bars, ({ value, tone }) =>
                h.span
                  .class(barToneVariants({ tone }))
                  .attr("title", `${group.label}: ${value}`)
                  .style({ height: `${(Math.abs(value) / maximum) * 100}%` }),
              ),
            ),
          h.span
            .class("overflow-hidden text-ellipsis whitespace-nowrap text-[0.75rem]")
            .attr("data-slot", "bar-chart-label")
            .attr("title", group.label)
            .children(group.label),
        ),
      ),
    );
};

export const barChart: {
  <M>(label: string, groups: ReadonlyArray<BarGroup>): (h: Html.H<M>) => Markup<M>;
  <M>(h: Html.H<M>, label: string, groups: ReadonlyArray<BarGroup>): Markup<M>;
} = Fn.dual(3, barChartImpl);

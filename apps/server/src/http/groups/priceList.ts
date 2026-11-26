/** `priceList` group handlers (http-mcp-contracts 3.5.4): one PriceList method per endpoint. */
import { API_PREFIX, Api } from "@kvitbit/api-contract";
import { PriceList, type PriceListItemInput } from "@kvitbit/domain/contract";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { compact, requestOptions, setLocation, withRevision } from "../conventions";
import { jsonSafe } from "./records/json";

export const PriceListGroupLive = HttpApiBuilder.group(Api, "priceList", (handlers) =>
  Effect.gen(function* () {
    const priceList = yield* PriceList;
    return handlers
      .handle("list", ({ query }) => Effect.map(priceList.list(compact(query)), jsonSafe))
      .handle("create", ({ params, headers, payload }) =>
        priceList.save(payload, requestOptions(headers)).pipe(
          Effect.map(jsonSafe),
          Effect.tap((view) =>
            typeof view.id === "string"
              ? setLocation(
                  `${API_PREFIX}/workspaces/${params.workspaceId}/price-list-items/${view.id}`,
                )
              : Effect.void,
          ),
        ),
      )
      .handle("update", ({ params, headers, payload }) =>
        withRevision(headers["if-match"], (expectedRevision) => {
          const fields =
            typeof payload === "object" && payload !== null && !Array.isArray(payload)
              ? (payload as Record<string, unknown>)
              : {};
          return Effect.map(
            priceList.save({
              ...fields,
              id: params.itemId,
              expectedRevision,
            } as PriceListItemInput & {
              readonly id: typeof params.itemId;
              readonly expectedRevision: number;
            }),
            jsonSafe,
          );
        }),
      )
      .handle("archive", ({ params }) => priceList.archive(params.itemId));
  }),
);

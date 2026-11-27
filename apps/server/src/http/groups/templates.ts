/** `templates` group handlers (http-mcp-contracts 3.5.4): templates, recurring schedules, runs. */
import { API_PREFIX, Api } from "@kvitbit/api-contract";
import { Templates } from "@kvitbit/domain/contract";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { compact, requestOptions, setLocation, withRevision } from "../conventions";
import { jsonizeDocumentView } from "./documents/jsonize";
import { jsonSafe } from "./records/json";

export const TemplatesGroupLive = HttpApiBuilder.group(Api, "templates", (handlers) =>
  Effect.gen(function* () {
    const templates = yield* Templates;
    return handlers
      .handle("list", () => Effect.map(templates.list, jsonSafe))
      .handle("get", ({ params }) => Effect.map(templates.get(params.templateId), jsonSafe))
      .handle("create", ({ params, headers, payload }) =>
        templates.save(payload, requestOptions(headers)).pipe(
          Effect.map(jsonSafe),
          Effect.tap((view) =>
            typeof view.id === "string"
              ? setLocation(`${API_PREFIX}/workspaces/${params.workspaceId}/templates/${view.id}`)
              : Effect.void,
          ),
        ),
      )
      .handle("update", ({ params, headers, payload }) =>
        withRevision(headers["if-match"], (expectedRevision) =>
          Effect.map(
            templates.save({ ...payload, id: params.templateId, expectedRevision }),
            jsonSafe,
          ),
        ),
      )
      .handle("archive", ({ params }) => templates.archive(params.templateId))
      .handle("setSchedule", ({ params, headers, payload }) =>
        withRevision(headers["if-match"], (expectedRevision) =>
          Effect.map(templates.schedule(params.templateId, payload, expectedRevision), jsonSafe),
        ),
      )
      .handle("removeSchedule", ({ params, headers }) =>
        withRevision(headers["if-match"], (expectedRevision) =>
          Effect.map(templates.schedule(params.templateId, null, expectedRevision), jsonSafe),
        ),
      )
      .handle("resume", ({ params }) => Effect.map(templates.resume(params.templateId), jsonSafe))
      .handle("runs", ({ params, query }) => templates.runs(params.templateId, compact(query)))
      .handle("use", ({ params, headers, payload }) =>
        templates.use(params.templateId, payload, requestOptions(headers)).pipe(
          Effect.map(jsonizeDocumentView),
          Effect.tap((view) =>
            setLocation(`${API_PREFIX}/workspaces/${params.workspaceId}/documents/${view.id}`),
          ),
        ),
      );
  }),
);

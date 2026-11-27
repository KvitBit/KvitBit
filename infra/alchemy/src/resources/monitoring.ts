import type { ProjectService } from "@alchemy.run/gcp/ServiceUsage";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import { type KvitbitStackConfig, resourceNames } from "../config";
import {
  AlertPolicy,
  type MetricAggregation,
  NotificationChannel,
  UptimeCheck,
} from "./monitoring-provider";

const uptimeTarget = ({ appOrigin, edge }: KvitbitStackConfig) => {
  const origin = appOrigin === undefined ? null : URL.parse(appOrigin);
  if (origin?.protocol === "https:") return origin;
  const edgeDomain = edge?.enableHttps ? edge.domains[0] : undefined;
  return edgeDomain === undefined ? null : new URL(`https://${edgeDomain}`);
};

const errorRateCondition = (serviceName: string) => {
  const denominatorFilter = [
    'metric.type="run.googleapis.com/request_count"',
    'resource.type="cloud_run_revision"',
    `resource.label.service_name="${serviceName}"`,
  ].join(" AND ");
  // Sum the same five-minute request window across revisions and response codes on both sides.
  const aggregations = [
    {
      alignmentPeriod: "300s",
      perSeriesAligner: "ALIGN_DELTA",
      crossSeriesReducer: "REDUCE_SUM",
    },
  ] satisfies Array<MetricAggregation>;

  return {
    displayName: "HTTP 5xx ratio exceeds 5% over five minutes",
    conditionThreshold: {
      filter: `${denominatorFilter} AND metric.label.response_code_class="5xx"`,
      aggregations,
      denominatorFilter,
      denominatorAggregations: aggregations,
      comparison: "COMPARISON_GT",
      thresholdValue: 0.05,
      duration: "0s",
      trigger: { count: 1 },
    },
  } as const;
};

const uptimeFailureCondition = (checkId: string) =>
  ({
    displayName: "Readiness check fails from multiple locations",
    conditionThreshold: {
      filter: [
        'metric.type="monitoring.googleapis.com/uptime_check/check_passed"',
        'resource.type="uptime_url"',
        `metric.label.check_id="${checkId}"`,
      ].join(" AND "),
      aggregations: [
        {
          alignmentPeriod: "300s",
          perSeriesAligner: "ALIGN_NEXT_OLDER",
          crossSeriesReducer: "REDUCE_COUNT_FALSE",
        },
      ],
      comparison: "COMPARISON_GT",
      thresholdValue: 1,
      duration: "120s",
      trigger: { count: 1 },
    },
  }) as const;

export const declareMonitoring = Effect.fn("KvitbitStack.declareMonitoring")(function* (
  config: KvitbitStackConfig,
  monitoringApi: ProjectService,
  serverServiceId: Output.Output<string>,
  edgeHttpsForwardingRule?: Output.Output<string | undefined>,
) {
  const target = uptimeTarget(config);
  if (target === null && config.alertEmail === undefined) return;

  // Delay the providers' first read until Service Usage has enabled the API.
  const project = config.projectId;
  const apiReady = monitoringApi.state;
  const { prefix } = resourceNames(config);
  const channel =
    config.alertEmail === undefined
      ? undefined
      : yield* NotificationChannel("MonitoringEmail", {
          project,
          apiReady,
          displayName: `${prefix} operations email`,
          email: config.alertEmail,
        });
  const notificationChannels = channel?.name.pipe(Output.map((name) => [name])) ?? [];

  yield* AlertPolicy("MonitoringCloudRunErrors", {
    project,
    apiReady,
    displayName: `${prefix} Cloud Run 5xx rate`,
    condition: serverServiceId.pipe(Output.map(errorRateCondition)),
    notificationChannels,
  });

  if (target !== null) {
    const readinessDependencies =
      edgeHttpsForwardingRule === undefined
        ? [serverServiceId]
        : [serverServiceId, edgeHttpsForwardingRule];
    const uptime = yield* UptimeCheck("MonitoringReadinessCheck", {
      project,
      apiReady: Output.all(apiReady, ...readinessDependencies).pipe(Output.map(([state]) => state)),
      displayName: `${prefix} HTTPS readiness`,
      host: target.hostname,
      port: target.port === "" ? 443 : Number(target.port),
      period: "60s",
    });
    yield* AlertPolicy("MonitoringReadinessFailure", {
      project,
      apiReady,
      displayName: `${prefix} HTTPS readiness failure`,
      condition: uptime.resourceId.pipe(Output.map(uptimeFailureCondition)),
      notificationChannels,
    });
  }
});

import { TemplateId } from "@kvitbit/domain/contract";
import * as Schema from "effect/Schema";
import { useLocalSearchParams } from "expo-router";
import { ErrorScreen } from "../../../../src/features/auth/error-screen";
import {
  TemplateDetailScreen,
  type TemplateDetailTab,
} from "../../../../src/features/templates/template-detail-screen";
import { param } from "../../../../src/navigation/routes";

export default function Route() {
  const params = useLocalSearchParams<{ id?: string; tab?: string }>();
  const rawId = param(params.id) ?? "new";
  const rawTab = param(params.tab);
  const initialTab: TemplateDetailTab =
    rawTab === "schedule" || rawTab === "runs" ? rawTab : "template";
  if (rawId === "new") return <TemplateDetailScreen id={rawId} initialTab={initialTab} />;
  const id = Schema.decodeOption(TemplateId)(rawId);
  return id._tag === "Some" ? (
    <TemplateDetailScreen id={id.value} initialTab={initialTab} />
  ) : (
    <ErrorScreen kind="not_found" />
  );
}

import type { TemplateId } from "@kvitbit/domain/contract";
import { useLocalSearchParams } from "expo-router";
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
  return (
    <TemplateDetailScreen
      id={rawId === "new" ? "new" : (rawId as TemplateId)}
      initialTab={initialTab}
    />
  );
}

import type { TemplateId } from "@kvitbit/domain/contract";
import { formatDate } from "@kvitbit/ui-port/format";
import * as Arr from "effect/Array";
import { CalendarClock, FileText, Plus } from "lucide-react-native";
import { useCallback, useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useI18n } from "../../i18n/i18n-provider";
import { navigate } from "../../navigation/routes";
import { useRemote } from "../../runtime/api-runtime";
import {
  Badge,
  type BadgeTone,
  type Choice,
  EmptyState,
  IconButton,
  ListRow,
  RemoteView,
  Screen,
  Section,
  SegmentedChoice,
  space,
} from "../../ui";
import { useWorkspace } from "../../workspace/workspace-provider";
import {
  cadenceParts,
  decodeTemplate,
  filterTemplates,
  type ScheduleState,
  scheduleStateOf,
  type TemplateFilter,
} from "./model";

const scheduleTone = (state: ScheduleState): BadgeTone => {
  switch (state) {
    case "active":
      return "success";
    case "paused":
      return "warning";
    case "ended":
      return "neutral";
    case "none":
      return "draft";
  }
};

export function TemplatesListScreen() {
  const { workspace } = useWorkspace();
  const { t, locale, local } = useI18n();
  const [filter, setFilter] = useState<TemplateFilter>("all");

  const remote = useRemote(
    (client) => client.templates.list({ params: { workspaceId: workspace.id } }),
    [workspace.id],
  );

  const openNew = useCallback(() => {
    navigate({ _tag: "Template", ws: workspace.slug, id: "new", tab: "template" });
  }, [workspace.slug]);

  const openDetail = useCallback(
    (id: TemplateId) => {
      navigate({ _tag: "Template", ws: workspace.slug, id, tab: "template" });
    },
    [workspace.slug],
  );

  const filterChoices: ReadonlyArray<Choice<TemplateFilter>> = useMemo(
    () => [
      { value: "all", label: t("common.state.all") },
      { value: "active", label: t("enum.scheduleState.active") },
      { value: "paused", label: t("enum.scheduleState.paused") },
      { value: "one_off", label: local({ cs: "Jednorázové", en: "One-off" }) },
    ],
    [local, t],
  );

  return (
    <Screen
      title={t("templates.list.title")}
      back
      onRefresh={remote.reload}
      refreshing={remote.state._tag === "Loading"}
      actions={<IconButton icon={Plus} label={t("templates.list.new")} onPress={openNew} />}
    >
      <View style={styles.filters}>
        <SegmentedChoice value={filter} choices={filterChoices} onChange={setFilter} />
      </View>

      <RemoteView state={remote.state} onRetry={remote.reload}>
        {(rawItems) => {
          const all = Arr.flatMap(rawItems, (raw) => {
            const template = decodeTemplate(raw);
            return template === null ? [] : [template];
          });
          if (all.length === 0) {
            return (
              <EmptyState
                title={t("templates.list.empty.title")}
                body={t("templates.list.empty.body")}
                action={{ label: t("templates.list.empty.cta"), onPress: openNew }}
              />
            );
          }

          const visible = filterTemplates(all, filter);
          if (visible.length === 0) {
            return (
              <EmptyState
                title={t("common.state.noMatches")}
                action={{ label: t("common.action.clearFilters"), onPress: () => setFilter("all") }}
              />
            );
          }

          return (
            <Section>
              {Arr.map(visible, (tpl) => {
                const state = scheduleStateOf(tpl.schedule);
                const metaParts: Array<string> = [t(`enum.documentKind.${tpl.kind}`)];
                if (tpl.currency !== null) metaParts.push(tpl.currency);
                if (tpl.schedule !== null) {
                  const { unit, count } = cadenceParts(tpl.schedule.every);
                  metaParts.push(`${count}× ${t(`enum.cadenceUnit.${unit}`)}`);
                  if (tpl.schedule.nextOccurrence !== null) {
                    metaParts.push(
                      t("templates.list.nextRun", {
                        date: formatDate(locale, tpl.schedule.nextOccurrence),
                      }),
                    );
                  }
                }

                const badge = tpl.archived ? (
                  <Badge label={t("enum.badge.archived")} tone="neutral" />
                ) : state === "none" ? (
                  <Badge label={local({ cs: "Šablona", en: "Template" })} tone="draft" />
                ) : (
                  <Badge label={t(`enum.scheduleState.${state}`)} tone={scheduleTone(state)} />
                );

                return (
                  <ListRow
                    key={tpl.id}
                    testID={`template-row-${tpl.id}`}
                    leading={tpl.schedule !== null ? CalendarClock : FileText}
                    title={tpl.name}
                    subtitle={Arr.join(metaParts, " · ")}
                    badge={badge}
                    onPress={() => openDetail(tpl.id)}
                  />
                );
              })}
            </Section>
          );
        }}
      </RemoteView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  filters: { gap: space.sm },
});

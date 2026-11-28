import type { ContactRole, WorkspaceSummary } from "@kvitbit/domain/contract";
import { describeError, inWorkspace, Paged, type Paged as PagedState } from "@kvitbit/ui-port/api";
import { enumKey } from "@kvitbit/ui-port/i18n";
import type { Route } from "@kvitbit/ui-port/view-models";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { Plus, User, X } from "lucide-react-native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useI18n } from "../../i18n/i18n-provider";
import { navigate } from "../../navigation/routes";
import { useApi } from "../../runtime/api-runtime";
import {
  Badge,
  Banner,
  Button,
  Card,
  type Choice,
  EmptyState,
  IconButton,
  ListRow,
  Loading,
  Screen,
  SegmentedChoice,
  SwitchRow,
  space,
  TextField,
} from "../../ui";
import { useWorkspace } from "../../workspace/workspace-provider";
import { canWriteWorkspace } from "../dashboard/model";
import { forkFeatureEffect } from "../ui-effect";
import {
  type ContactQuery,
  type ContactRecord,
  contactSubtitle,
  filterVisibleContacts,
  loadContactsQuery,
  parseContactViews,
} from "./model";

type RoleFilter = "all" | ContactRole;

export interface ContactsListContentProps {
  readonly workspace: WorkspaceSummary;
  readonly searchText: string;
  readonly onChangeSearchText: (text: string) => void;
  readonly roleFilter: RoleFilter;
  readonly onChangeRoleFilter: (role: RoleFilter) => void;
  readonly showArchived: boolean;
  readonly onChangeShowArchived: (show: boolean) => void;
  readonly paged: PagedState<ContactRecord, ContactQuery>;
  readonly onRetry: () => void;
  readonly onLoadMore: () => void;
  readonly onClearFilters: () => void;
  readonly onNavigate: (route: Route) => void;
}

export function ContactsListContent(props: ContactsListContentProps) {
  const { t, text } = useI18n();
  const ws = props.workspace.slug;
  const writable = canWriteWorkspace(props.workspace);

  const roleChoices: ReadonlyArray<Choice<RoleFilter>> = useMemo(
    () => [
      { value: "all", label: t("common.state.all") },
      { value: "customer", label: t(enumKey({ name: "contactRole", value: "customer" })) },
      { value: "supplier", label: t(enumKey({ name: "contactRole", value: "supplier" })) },
    ],
    [t],
  );

  const visible = useMemo(
    () => filterVisibleContacts(props.paged.items, props.showArchived),
    [props.paged.items, props.showArchived],
  );

  const hasFilters =
    Str.trim(props.searchText) !== "" || props.roleFilter !== "all" || props.showArchived;

  const errorBanner = Option.isSome(props.paged.error)
    ? (() => {
        const view = describeError(props.paged.error.value);
        return (
          <Banner
            text={text(view.text)}
            {...(view.retryable
              ? { action: { label: t("common.action.retry"), onPress: props.onRetry } }
              : {})}
          />
        );
      })()
    : null;

  return (
    <View style={styles.stack}>
      {props.workspace.closed ? <Banner tone="warning" text={t("shell.closedWorkspace")} /> : null}

      <TextField
        label={t("common.field.search")}
        placeholder={t("contacts.list.search")}
        value={props.searchText}
        onChangeText={props.onChangeSearchText}
        returnKeyType="search"
        trailing={
          props.searchText !== "" ? (
            <IconButton
              icon={X}
              label={t("common.action.clear")}
              onPress={() => props.onChangeSearchText("")}
            />
          ) : undefined
        }
      />

      <SegmentedChoice
        label={t("common.field.role")}
        value={props.roleFilter}
        choices={roleChoices}
        onChange={props.onChangeRoleFilter}
      />

      <SwitchRow
        label={t("contacts.list.showArchived")}
        value={props.showArchived}
        onChange={props.onChangeShowArchived}
      />

      {errorBanner}

      {props.paged.status === "loading" && visible.length === 0 ? (
        <Loading label={t("common.state.loading")} />
      ) : visible.length === 0 ? (
        <Card>
          {hasFilters ? (
            <EmptyState
              title={t("common.state.noMatches")}
              body={t("common.state.noMatchesHint")}
              action={{ label: t("common.action.clearFilters"), onPress: props.onClearFilters }}
            />
          ) : (
            <EmptyState
              title={t("contacts.list.empty.title")}
              body={t("contacts.list.empty.body")}
              {...(writable
                ? {
                    action: {
                      label: t("contacts.list.empty.cta"),
                      onPress: () =>
                        props.onNavigate({ _tag: "Contact", ws, id: "new", mode: "edit" }),
                    },
                  }
                : {})}
            />
          )}
        </Card>
      ) : (
        <Card style={styles.listCard}>
          {Arr.map(visible, (contact) => {
            const sub = contactSubtitle(contact);
            return (
              <ListRow
                key={contact.id}
                testID={`contact-row-${contact.id}`}
                leading={User}
                title={contact.name}
                {...(sub !== "" ? { subtitle: sub } : {})}
                badge={
                  <View style={styles.badges}>
                    {Arr.map(contact.roles, (role) => (
                      <Badge
                        key={role}
                        tone={role === "customer" ? "info" : "neutral"}
                        label={t(enumKey({ name: "contactRole", value: role }))}
                      />
                    ))}
                    {contact.archived ? (
                      <Badge tone="draft" label={t("common.action.archive")} />
                    ) : null}
                  </View>
                }
                onPress={() =>
                  props.onNavigate({ _tag: "Contact", ws, id: contact.id, mode: "view" })
                }
              />
            );
          })}
        </Card>
      )}

      {Paged.hasMore(props.paged) ? (
        <Button
          kind="outlined"
          label={t("common.action.loadMore")}
          busy={props.paged.status === "loading_more"}
          onPress={props.onLoadMore}
        />
      ) : null}
    </View>
  );
}

const buildQuery = (text: string, roleFilter: RoleFilter): ContactQuery => {
  const trimmed = Str.trim(text);
  if (trimmed === "") return roleFilter === "all" ? {} : { role: roleFilter };
  return roleFilter === "all" ? { text: trimmed } : { text: trimmed, role: roleFilter };
};

export function ContactsListScreen() {
  const { workspace } = useWorkspace();
  return <WorkspaceContactsList key={workspace.id} workspace={workspace} />;
}

function WorkspaceContactsList({ workspace }: { readonly workspace: WorkspaceSummary }) {
  const api = useApi();
  const { t } = useI18n();
  const writable = canWriteWorkspace(workspace);

  const [searchText, setSearchText] = useState("");
  const [roleFilter, setRoleFilter] = useState<RoleFilter>("all");
  const [showArchived, setShowArchived] = useState(false);

  const [paged, setPaged] = useState<PagedState<ContactRecord, ContactQuery>>(
    () => Paged.init<ContactRecord, ContactQuery>({}).paged,
  );
  const pagedRef = useRef(paged);

  const runFetch = useCallback(
    (step: ReturnType<typeof Paged.init<ContactRecord, ContactQuery>>) =>
      forkFeatureEffect(
        Effect.gen(function* () {
          setPaged(step.paged);
          pagedRef.current = step.paged;
          if (step.fetch === null) return;
          const { seq, query } = step.fetch;
          const result = yield* Effect.promise(() =>
            api.run((client) =>
              client.contacts.search({
                params: inWorkspace(workspace.id),
                query: {
                  text: query.text,
                  role: query.role,
                  cursor: query.cursor,
                  limit: query.limit,
                },
              }),
            ),
          );
          const mapped =
            result._tag === "Ok"
              ? ({
                  ...result,
                  value: {
                    items: parseContactViews(result.value.items),
                    nextCursor: result.value.nextCursor,
                  },
                } as const)
              : result;
          const nextStep = Paged.receive(pagedRef.current, seq, mapped);
          if (nextStep.fetch !== null) {
            runFetch(nextStep);
          } else {
            setPaged(nextStep.paged);
            pagedRef.current = nextStep.paged;
          }
        }),
      ),
    [api, workspace.id],
  );

  useEffect(() => {
    runFetch(
      loadContactsQuery({ current: pagedRef.current, query: buildQuery(searchText, roleFilter) }),
    );
  }, [runFetch, searchText, roleFilter]);

  const onRefresh = useCallback(() => {
    runFetch(Paged.refresh(pagedRef.current));
  }, [runFetch]);

  const onLoadMore = useCallback(() => {
    runFetch(Paged.loadMore(pagedRef.current));
  }, [runFetch]);

  const onClearFilters = useCallback(() => {
    setSearchText("");
    setRoleFilter("all");
    setShowArchived(false);
  }, []);

  return (
    <Screen
      title={t("contacts.list.title")}
      onRefresh={onRefresh}
      refreshing={paged.status === "refreshing"}
      actions={
        writable ? (
          <IconButton
            icon={Plus}
            label={t("contacts.list.new")}
            onPress={() =>
              navigate({ _tag: "Contact", ws: workspace.slug, id: "new", mode: "edit" })
            }
          />
        ) : undefined
      }
    >
      <ContactsListContent
        workspace={workspace}
        searchText={searchText}
        onChangeSearchText={setSearchText}
        roleFilter={roleFilter}
        onChangeRoleFilter={setRoleFilter}
        showArchived={showArchived}
        onChangeShowArchived={setShowArchived}
        paged={paged}
        onRetry={onRefresh}
        onLoadMore={onLoadMore}
        onClearFilters={onClearFilters}
        onNavigate={(route) => navigate(route)}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  stack: { gap: space.lg },
  listCard: { padding: space.xs, gap: 0 },
  badges: { flexDirection: "row", flexWrap: "wrap", gap: space.xs, justifyContent: "flex-end" },
});

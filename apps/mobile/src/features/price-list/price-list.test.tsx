import { describe, expect, mock, test } from "bun:test";
import type {
  CurrencyCode,
  PriceListItemId,
  WorkspaceId,
  WorkspaceSlug,
  WorkspaceSummary,
} from "@kvitbit/domain/contract";
import { Remote as RemoteOps, sessionCookie } from "@kvitbit/ui-port/api";
import { BigDecimal } from "effect";
import type { ReactElement } from "react";
import { makeApiRunner } from "../../runtime/api-runtime";
import { expoRouterStandIn } from "../../testing/expo-router-stand-in";
import {
  buildPriceListInput,
  emptyPriceListForm,
  normalizeDecimalInput,
  type PriceListItemRecord,
  parsePriceListItem,
  priceListFormFromItem,
  validatePriceListForm,
} from "./model";

mock.module("expo-router", () => expoRouterStandIn());

const { allText, findAll, hostTree } = await import("../../testing/element-tree");
type HostProps = import("../../testing/element-tree").HostProps;
const { TestProviders } = await import("../../testing/providers");
const { PriceListContent, reloadPriceListItem } = await import("./price-list-screen");

const CZK = "CZK" as CurrencyCode;

const workspace: WorkspaceSummary = {
  id: "01937c7a-0000-7000-8000-000000000001" as WorkspaceId,
  slug: "acme" as WorkspaceSlug,
  name: "Acme s.r.o.",
  role: "owner",
  memberCount: 1,
  taxRegime: "vat_payer",
  closed: false,
};

const sampleItem: PriceListItemRecord = {
  id: "pli_1" as PriceListItemId,
  name: "Senior Consulting",
  description: "Architecture & code review",
  unit: "h",
  unitPrice: BigDecimal.fromNumberUnsafe(2400),
  currency: CZK,
  vat: "standard",
  archived: false,
  revision: 2,
};

const within = (node: ReactElement) => <TestProviders>{node}</TestProviders>;

describe("price list model", () => {
  test("stale editor reload searches the unfiltered list for the latest active revision", async () => {
    const changed = {
      ...sampleItem,
      unitPrice: "2400",
      name: "Renamed elsewhere",
      revision: sampleItem.revision + 1,
    };
    const requested: URL[] = [];
    let archived = false;
    const server = Bun.serve({
      port: 0,
      fetch: (req) => {
        requested.push(new URL(req.url));
        return Response.json([{ ...changed, archived }]);
      },
    });

    const api = makeApiRunner(server.url.origin, sessionCookie, () => "en");
    const reload = () =>
      api.run((client) => reloadPriceListItem(client.priceList, workspace.id, sampleItem.id));
    try {
      const current = await reload();
      if (current._tag !== "Ok" || current.value === undefined) {
        throw new Error("Expected the renamed item");
      }
      expect(priceListFormFromItem(current.value)).toMatchObject({
        name: changed.name,
        editingRevision: changed.revision,
      });
      expect(requested[0]?.pathname).toBe(`/api/v1/workspaces/${workspace.id}/price-list-items`);
      expect(requested[0]?.search).toBe("");

      archived = true;
      const removed = await reload();
      expect(removed).toMatchObject({ _tag: "Ok", value: undefined });
    } finally {
      await api.dispose();
      server.stop(true);
    }
  });

  test("parses PriceListItemView and normalizes Czech decimal inputs", () => {
    const parsed = parsePriceListItem({
      id: "pli_1",
      name: "Hosting",
      description: "Monthly plan",
      unit: "month",
      unitPrice: "499.50",
      currency: "CZK",
      vat: "reduced",
      archived: false,
      revision: 1,
    });
    expect(parsed?.name).toBe("Hosting");
    expect(parsed?.vat).toBe("reduced");
    expect(parsePriceListItem({ bad: true })).toBeNull();

    expect(normalizeDecimalInput("1 250,50")).toBe("1250.50");
    expect(normalizeDecimalInput(" 49.90 ")).toBe("49.90");
  });

  test("validates price list form and builds wire payload", () => {
    const emptyErrors = validatePriceListForm(emptyPriceListForm());
    expect(emptyErrors.name).toBe("name_required");
    expect(emptyErrors.unitPrice).toBe("price_invalid");

    const form = priceListFormFromItem(sampleItem);
    expect(validatePriceListForm(form)).toEqual({});

    const payload = buildPriceListInput({
      ...form,
      unitPrice: "2 500,50",
      description: "  ",
    }) as unknown as Record<string, unknown>;
    expect(payload).toEqual({
      name: "Senior Consulting",
      description: null,
      unit: "h",
      unitPrice: "2500.50",
      currency: "CZK",
      vat: "standard",
    });
  });
});

describe("PriceListContent", () => {
  test("renders items with formatted price, unit, VAT treatment and edit/archive actions", () => {
    const edited: PriceListItemRecord[] = [];
    const archived: PriceListItemRecord[] = [];
    const tree = hostTree(
      <PriceListContent
        workspace={workspace}
        searchText=""
        onChangeSearchText={() => undefined}
        includeArchived={false}
        onChangeIncludeArchived={() => undefined}
        itemsRemote={RemoteOps.ready([sampleItem])}
        visibleItems={[sampleItem]}
        onRetry={() => undefined}
        editor={null}
        onStartCreate={() => undefined}
        onStartEdit={(item) => {
          edited.push(item);
        }}
        onArchive={(item) => {
          archived.push(item);
        }}
        onClearFilters={() => undefined}
      />,
      within,
    ) as ReactElement<HostProps>;

    const text = allText(tree);
    expect(text).toContain("Senior Consulting");
    expect(text).toContain("/ h");
    expect(text).toContain("Architecture & code review");

    const pressables = findAll<{ onPress?: () => void }>(tree, "Pressable");
    pressables.find((p) => allText(p) === "Edit")?.props.onPress?.();
    pressables.find((p) => allText(p) === "Archive")?.props.onPress?.();
    expect(edited[0]?.id).toBe("pli_1" as PriceListItemId);
    expect(archived[0]?.id).toBe("pli_1" as PriceListItemId);
  });

  test("renders inline editor with stale revision reload and saves", () => {
    let saved = 0;
    let reloaded = 0;
    const tree = hostTree(
      <PriceListContent
        workspace={workspace}
        searchText=""
        onChangeSearchText={() => undefined}
        includeArchived={false}
        onChangeIncludeArchived={() => undefined}
        itemsRemote={RemoteOps.ready([sampleItem])}
        visibleItems={[sampleItem]}
        onRetry={() => undefined}
        editor={{
          form: priceListFormFromItem(sampleItem),
          onChangeForm: () => undefined,
          clientErrors: {},
          serverIssues: [],
          bannerError: null,
          staleRevision: true,
          onReload: () => reloaded++,
          onSave: () => saved++,
          onCancel: () => undefined,
          saving: false,
        }}
        onStartCreate={() => undefined}
        onStartEdit={() => undefined}
        onArchive={() => undefined}
        onClearFilters={() => undefined}
      />,
      within,
    ) as ReactElement<HostProps>;

    const text = allText(tree);
    expect(text).toContain("Edit: Senior Consulting");
    expect(text).toContain("Reload");

    const pressables = findAll<{ testID?: string; onPress?: () => void }>(tree, "Pressable");
    pressables.find((p) => p.props.testID === "price-list-save-button")?.props.onPress?.();
    pressables.find((p) => allText(p).includes("Reload"))?.props.onPress?.();
    expect(saved).toBe(1);
    expect(reloaded).toBe(1);
  });

  test("shows empty state and hides write actions when workspace is closed", () => {
    const tree = hostTree(
      <PriceListContent
        workspace={{ ...workspace, closed: true }}
        searchText=""
        onChangeSearchText={() => undefined}
        includeArchived={false}
        onChangeIncludeArchived={() => undefined}
        itemsRemote={RemoteOps.ready([])}
        visibleItems={[]}
        onRetry={() => undefined}
        editor={null}
        onStartCreate={() => undefined}
        onStartEdit={() => undefined}
        onArchive={() => undefined}
        onClearFilters={() => undefined}
      />,
      within,
    ) as ReactElement<HostProps>;

    const text = allText(tree);
    expect(text).toContain("No items yet");
    expect(text).not.toContain("Add your first item");
    expect(text).toContain("This workspace is closed. Everything is read only.");
  });
});

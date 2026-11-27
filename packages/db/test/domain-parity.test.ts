import { describe, expect, test } from "bun:test";
import * as Domain from "@kvitbit/domain/contract";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import * as Enums from "../src/schema/enums";

// The db enum tuples are copied from the specs (see enums.ts); these checks keep
// them equal to the @kvitbit/domain literals so the two cannot drift.
const pairs: ReadonlyArray<readonly [string, ReadonlyArray<string>, ReadonlyArray<string>]> = [
  ["Role", Enums.roleValues, Domain.Role.literals],
  ["InvitationRole", Enums.invitationRoleValues, Domain.InvitationRole.literals],
  ["InvitationStatus", Enums.invitationStatusValues, Domain.InvitationStatus.literals],
  ["DeliveryStatus", Enums.deliveryStatusValues, Domain.DeliveryStatus.literals],
  ["DocumentRelation", Enums.documentRelationValues, Domain.DocumentRelation.literals],
  ["ExpenseStatus", Enums.expenseStatusValues, Domain.ExpenseStatus.literals],
  ["TaxRegime", Enums.taxRegimeValues, Domain.TaxRegime.literals],
  ["Locale", Enums.localeValues, Domain.Locale.literals],
  ["DocumentKind", Enums.documentKindValues, Domain.DocumentKind.literals],
  ["DocumentStatus", Enums.documentStatusValues, Domain.DocumentStatus.literals],
  ["DocumentSettlement", Enums.documentSettlementValues, Domain.DocumentSettlement.literals],
  ["PaymentMethod", Enums.paymentMethodValues, Domain.PaymentMethod.literals],
  ["VatTreatment", Enums.vatTreatmentValues, Domain.VatTreatment.literals],
  ["EntityKind", Enums.entityKindValues, Domain.EntityKind.literals],
  ["PdfTemplate", Enums.pdfTemplateValues, Domain.PdfTemplate.literals],
  ["DeliveryPurpose", Enums.deliveryPurposeValues, Domain.DeliveryPurpose.literals],
  ["Channel", Enums.channelValues, Domain.Channel.literals],
  ["ScopeArea", Enums.scopeAreaValues, Domain.SCOPE_AREAS],
  ["ThemePresetId", Enums.themePresetIdValues, Domain.ThemePresetId.literals],
  ["ThemeMode", Enums.themeModeValues, Domain.ThemeMode.literals],
  ["ThemeStyle", Enums.themeStyleValues, Domain.ThemeStyle.literals],
  ["ThemeContrast", Enums.themeContrastValues, Domain.ThemeContrast.literals],
];

describe("db enums match @kvitbit/domain literals", () => {
  for (const [name, db, domain] of pairs) {
    test(name, () => {
      expect(Arr.sort(db, Order.String)).toEqual(Arr.sort(domain, Order.String));
    });
  }
});

import type { ContactId, DocumentId } from "@kvitbit/domain/contract";
import { useLocalSearchParams } from "expo-router";
import {
  CreditNoteCreatorScreen,
  DocumentEditorScreen,
} from "../../../../../src/features/documents/editor-screen";
import { param } from "../../../../../src/navigation/routes";

export default function DocumentNewRoute() {
  const params = useLocalSearchParams<{
    kind?: string | string[];
    contact?: string | string[];
    duplicate?: string | string[];
  }>();
  const rawKind = param(params.kind);
  if (rawKind === "credit_note") {
    return <CreditNoteCreatorScreen />;
  }
  const kind = rawKind === "proforma" ? "proforma" : "invoice";
  const contact = param(params.contact) as ContactId | undefined;
  const duplicate = param(params.duplicate) as DocumentId | undefined;
  return (
    <DocumentEditorScreen
      mode="new"
      kind={kind}
      {...(contact !== undefined ? { contactId: contact } : {})}
      {...(duplicate !== undefined ? { duplicateId: duplicate } : {})}
    />
  );
}

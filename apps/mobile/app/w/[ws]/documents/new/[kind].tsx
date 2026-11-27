import { ContactId, DocumentId, TemplateId } from "@kvitbit/domain/contract";
import * as Schema from "effect/Schema";
import { useLocalSearchParams } from "expo-router";
import { ErrorScreen } from "../../../../../src/features/auth/error-screen";
import {
  CreditNoteCreatorScreen,
  DocumentEditorScreen,
  DocumentFromTemplateScreen,
} from "../../../../../src/features/documents/editor-screen";
import { param } from "../../../../../src/navigation/routes";

export default function DocumentNewRoute() {
  const params = useLocalSearchParams<{
    kind?: string | string[];
    contact?: string | string[];
    duplicate?: string | string[];
    template?: string | string[];
  }>();
  const rawKind = param(params.kind);
  if (rawKind === "credit_note") {
    return <CreditNoteCreatorScreen />;
  }
  const kind = rawKind === "proforma" ? "proforma" : "invoice";
  const rawContact = param(params.contact);
  if (rawContact !== undefined) {
    const contact = Schema.decodeOption(ContactId)(rawContact);
    return contact._tag === "Some" ? (
      <DocumentEditorScreen mode="new" kind={kind} contactId={contact.value} />
    ) : (
      <ErrorScreen kind="not_found" />
    );
  }
  const rawTemplate = param(params.template);
  if (rawTemplate !== undefined) {
    const template = Schema.decodeOption(TemplateId)(rawTemplate);
    return template._tag === "Some" ? (
      <DocumentFromTemplateScreen key={template.value} templateId={template.value} />
    ) : (
      <ErrorScreen kind="not_found" />
    );
  }
  const rawDuplicate = param(params.duplicate);
  if (rawDuplicate === undefined) return <DocumentEditorScreen mode="new" kind={kind} />;
  const duplicate = Schema.decodeOption(DocumentId)(rawDuplicate);
  return duplicate._tag === "Some" ? (
    <DocumentEditorScreen mode="new" kind={kind} duplicateId={duplicate.value} />
  ) : (
    <ErrorScreen kind="not_found" />
  );
}

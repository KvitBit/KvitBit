/**
 * Branded identifiers (core-ports section 1).
 *
 * All ids are UUIDv7 except InvitationToken, ShareToken and VisitorHash. The brand is the
 * contract; the id format is chosen by whoever mints the value.
 * - InvitationToken: 32 random bytes, base64url; stored only as its SHA-256 hash.
 * - ShareToken: "v{keyVersion}." + base64url(HMAC-SHA256(shareKey[keyVersion], shareLinkId)).
 * - VisitorHash: HMAC of IP + user agent with a daily rotated key.
 */
import { Schema } from "effect";

export const WorkspaceId = Schema.String.pipe(Schema.brand("WorkspaceId"));
export type WorkspaceId = typeof WorkspaceId.Type;
export const UserId = Schema.String.pipe(Schema.brand("UserId"));
export type UserId = typeof UserId.Type;
export const ContactId = Schema.String.pipe(Schema.brand("ContactId"));
export type ContactId = typeof ContactId.Type;
export const PriceListItemId = Schema.String.pipe(Schema.brand("PriceListItemId"));
export type PriceListItemId = typeof PriceListItemId.Type;
export const DocumentId = Schema.String.pipe(Schema.brand("DocumentId"));
export type DocumentId = typeof DocumentId.Type;
export const LineId = Schema.String.pipe(Schema.brand("LineId"));
export type LineId = typeof LineId.Type;
export const PaymentId = Schema.String.pipe(Schema.brand("PaymentId"));
export type PaymentId = typeof PaymentId.Type;
export const ExpenseId = Schema.String.pipe(Schema.brand("ExpenseId"));
export type ExpenseId = typeof ExpenseId.Type;
export const AttachmentId = Schema.String.pipe(Schema.brand("AttachmentId"));
export type AttachmentId = typeof AttachmentId.Type;
export const TemplateId = Schema.String.pipe(Schema.brand("TemplateId"));
export type TemplateId = typeof TemplateId.Type;
export const ScheduleId = Schema.String.pipe(Schema.brand("ScheduleId"));
export type ScheduleId = typeof ScheduleId.Type;
export const NumberingSeriesId = Schema.String.pipe(Schema.brand("NumberingSeriesId"));
export type NumberingSeriesId = typeof NumberingSeriesId.Type;
export const BankAccountId = Schema.String.pipe(Schema.brand("BankAccountId"));
export type BankAccountId = typeof BankAccountId.Type;
export const InvitationId = Schema.String.pipe(Schema.brand("InvitationId"));
export type InvitationId = typeof InvitationId.Type;
export const InvitationToken = Schema.String.pipe(Schema.brand("InvitationToken"));
export type InvitationToken = typeof InvitationToken.Type;
export const DeliveryId = Schema.String.pipe(Schema.brand("DeliveryId"));
export type DeliveryId = typeof DeliveryId.Type;
export const AuditEntryId = Schema.String.pipe(Schema.brand("AuditEntryId"));
export type AuditEntryId = typeof AuditEntryId.Type;
export const ExportId = Schema.String.pipe(Schema.brand("ExportId"));
export type ExportId = typeof ExportId.Type;
export const ShareViewId = Schema.String.pipe(Schema.brand("ShareViewId"));
export type ShareViewId = typeof ShareViewId.Type;
export const ShareToken = Schema.String.pipe(Schema.brand("ShareToken"));
export type ShareToken = typeof ShareToken.Type;
export const VisitorHash = Schema.String.pipe(Schema.brand("VisitorHash"));
export type VisitorHash = typeof VisitorHash.Type;
export const RequestKey = Schema.String.pipe(Schema.brand("RequestKey"));
export type RequestKey = typeof RequestKey.Type;

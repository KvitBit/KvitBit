/**
 * Branded identifiers (core-ports section 1).
 *
 * All ids are UUIDv7 except InvitationToken, ShareToken and VisitorHash (and RequestKey, the
 * client-chosen retry key), so entity ids are checked as UUIDv7 before branding: a malformed
 * path parameter fails at decode.
 * - InvitationToken: 32 random bytes, base64url; stored only as its SHA-256 hash.
 * - ShareToken: "v{keyVersion}." + base64url(HMAC-SHA256(shareKey[keyVersion], shareLinkId)).
 * - VisitorHash: HMAC of IP + user agent with a daily rotated key.
 */
import { Schema } from "effect";

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const Uuid7 = Schema.String.pipe(Schema.check(Schema.isPattern(UUID_V7)));
const NonEmpty = Schema.String.pipe(Schema.check(Schema.isNonEmpty()));

export const WorkspaceId = Uuid7.pipe(Schema.brand("WorkspaceId"));
export type WorkspaceId = typeof WorkspaceId.Type;
export const UserId = Uuid7.pipe(Schema.brand("UserId"));
export type UserId = typeof UserId.Type;
export const ContactId = Uuid7.pipe(Schema.brand("ContactId"));
export type ContactId = typeof ContactId.Type;
export const PriceListItemId = Uuid7.pipe(Schema.brand("PriceListItemId"));
export type PriceListItemId = typeof PriceListItemId.Type;
export const DocumentId = Uuid7.pipe(Schema.brand("DocumentId"));
export type DocumentId = typeof DocumentId.Type;
export const LineId = Uuid7.pipe(Schema.brand("LineId"));
export type LineId = typeof LineId.Type;
export const PaymentId = Uuid7.pipe(Schema.brand("PaymentId"));
export type PaymentId = typeof PaymentId.Type;
export const ExpenseId = Uuid7.pipe(Schema.brand("ExpenseId"));
export type ExpenseId = typeof ExpenseId.Type;
export const AttachmentId = Uuid7.pipe(Schema.brand("AttachmentId"));
export type AttachmentId = typeof AttachmentId.Type;
export const TemplateId = Uuid7.pipe(Schema.brand("TemplateId"));
export type TemplateId = typeof TemplateId.Type;
export const ScheduleId = Uuid7.pipe(Schema.brand("ScheduleId"));
export type ScheduleId = typeof ScheduleId.Type;
export const NumberingSeriesId = Uuid7.pipe(Schema.brand("NumberingSeriesId"));
export type NumberingSeriesId = typeof NumberingSeriesId.Type;
export const BankAccountId = Uuid7.pipe(Schema.brand("BankAccountId"));
export type BankAccountId = typeof BankAccountId.Type;
export const InvitationId = Uuid7.pipe(Schema.brand("InvitationId"));
export type InvitationId = typeof InvitationId.Type;
export const InvitationToken = NonEmpty.pipe(Schema.brand("InvitationToken"));
export type InvitationToken = typeof InvitationToken.Type;
export const DeliveryId = Uuid7.pipe(Schema.brand("DeliveryId"));
export type DeliveryId = typeof DeliveryId.Type;
export const AuditEntryId = Uuid7.pipe(Schema.brand("AuditEntryId"));
export type AuditEntryId = typeof AuditEntryId.Type;
export const ExportId = Uuid7.pipe(Schema.brand("ExportId"));
export type ExportId = typeof ExportId.Type;
export const ShareViewId = Uuid7.pipe(Schema.brand("ShareViewId"));
export type ShareViewId = typeof ShareViewId.Type;
export const ShareToken = NonEmpty.pipe(Schema.brand("ShareToken"));
export type ShareToken = typeof ShareToken.Type;
export const VisitorHash = NonEmpty.pipe(Schema.brand("VisitorHash"));
export type VisitorHash = typeof VisitorHash.Type;
export const RequestKey = NonEmpty.pipe(Schema.brand("RequestKey"));
export type RequestKey = typeof RequestKey.Type;

/**
 * EmailSender adapters (core-ports section 6): Resend, SMTP, fallback, allowlist guard,
 * capture (tests) and console (dev).
 */
export {
  type AllowlistConfig,
  makeAllowlistEmailSender,
} from "./allowlist";
export {
  CAPTURE_PROVIDER,
  type CapturedEmail,
  type CaptureEmailSender,
  layerCapture,
  makeCaptureEmailSender,
} from "./capture";
export { CONSOLE_PROVIDER, layerConsole, makeConsoleEmailSender } from "./console";
export { type FallbackOptions, makeFallbackEmailSender } from "./fallback";
export {
  classifyResendStatus,
  classifyResendTransport,
  layerResend,
  makeResendEmailSender,
  RESEND_PROVIDER,
  type ResendConfig,
  resendBody,
  resendIdempotencyKey,
} from "./resend";
export { type EmailSenderService, singleMailbox } from "./shared";
export {
  classifySmtpError,
  layerSmtp,
  makeSmtpEmailSender,
  SMTP_DEFAULT_TIMEOUTS,
  SMTP_PROVIDER,
  type SmtpConfig,
  type SmtpMail,
  type SmtpSendInfo,
  type SmtpTransport,
  type SmtpTransportOptions,
  smtpMail,
  smtpMessageId,
} from "./smtp";

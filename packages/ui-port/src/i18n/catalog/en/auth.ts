import type { EnSection } from "../../types";

/** Screen 02 and ALTCHA bot proof. */
export const auth = {
  "auth.signUp.title": "Create your account",
  "auth.signUp.subtitle": "Free, no card required.",
  "auth.signUp.methodPassword": "Use a password",
  "auth.signUp.methodPasskey": "Use a passkey",
  "auth.signUp.passwordHint": "At least 10 characters.",
  "auth.signUp.acceptTerms": "I agree to the terms of service and privacy policy",
  "auth.signUp.submit": "Create account",
  "auth.signUp.haveAccount": "Already have an account?",
  "auth.signUp.invitationNote": "You will join the workspace you were invited to.",

  "auth.signIn.title": "Sign in to Kvitbit",
  "auth.signIn.submit": "Sign in",
  "auth.signIn.withPasskey": "Sign in with a passkey",
  "auth.signIn.withMagicLink": "Email me a sign-in link",
  "auth.signIn.withPassword": "Sign in with a password",
  "auth.signIn.sendLink": "Send link",
  "auth.signIn.forgotPassword": "Forgot password?",
  "auth.signIn.noAccount": "New to Kvitbit?",
  "auth.signIn.or": "or",

  "auth.checkEmail.title": "Check your email",
  "auth.checkEmail.body": "We sent a link to {email}. Open it on this device to continue.",
  "auth.checkEmail.resend": "Send the email again",
  "auth.checkEmail.resendIn": "You can resend in {seconds} s",
  "auth.checkEmail.resent": "Email sent again.",
  "auth.checkEmail.wrongEmail": "Wrong address? Go back",

  "auth.link.verifying": "Signing you in…",
  "auth.link.expired.title": "This link has expired",
  "auth.link.expired.body": "Links work once and expire after a while. Request a new one.",
  "auth.link.sendNew": "Send a new link",
  "auth.link.verified": "Your email is confirmed.",

  "auth.resetPassword.title": "Reset your password",
  "auth.resetPassword.requestBody": "Enter your email and we will send you a reset link.",
  "auth.resetPassword.send": "Send reset link",
  "auth.resetPassword.newPassword": "New password",
  "auth.resetPassword.confirmPassword": "Repeat the new password",
  "auth.resetPassword.submit": "Set new password",
  "auth.resetPassword.done": "Your password was changed. You can sign in now.",

  "auth.botProof.verifying": "Verifying you're human…",
  "auth.botProof.progress": "Verifying you're human… {percent} %",
  "auth.botProof.verified": "Verified",
  "auth.botProof.failed": "The check failed. Try again.",
  "auth.botProof.label": "Human check (no puzzle, runs on your device)",

  "auth.passkey.prompt": "Confirm with your fingerprint, face or security key.",
  "auth.passkey.unsupported": "Passkeys are not supported on this device.",
  "auth.genericError": "Sign-in failed. Check your details and try again.",
} as const satisfies EnSection;

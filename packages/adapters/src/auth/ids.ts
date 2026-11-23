/**
 * Ids for Better Auth rows and API Keys. Every entity id is a UUIDv7 string (core-ports
 * section 1, `@kvitbit/domain` ids), so Better Auth's `generateId` returns one for all models.
 */
import { randomUUIDv7 } from "bun";

/** A new lowercase UUIDv7 (time-ordered, RFC 9562). */
export const generateId = (): string => randomUUIDv7();

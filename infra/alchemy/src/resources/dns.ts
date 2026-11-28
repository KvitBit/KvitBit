// Alchemy resource names and instance props need a synchronous SHA-256. Effect Digest is asynchronous.

import { createHash } from "node:crypto";
import * as DNS from "@alchemy.run/gcp/DNS";
import type { ProjectService } from "@alchemy.run/gcp/ServiceUsage";
import * as Output from "alchemy/Output";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { type KvitbitStackConfig, resourceNames, stackLabels } from "../config";

const matchPattern = /^(\d+)\s+(\S+)$/;

const zoneNameFor = (prefix: string, domain: string) => {
  const slug = Str.replaceAll(".", "-")(domain);
  const hash = Str.slice(0, 12)(createHash("sha256").update(domain).digest("hex"));
  return `${prefix}-${Str.slice(0, 63 - prefix.length - hash.length - 2)(slug)}-${hash}`;
};

/**
 * Formats a raw TXT value for Google Cloud DNS `rrdatas`.
 *
 * Splits strings exceeding the RFC 1035 255-byte per-string limit (such as 2048-bit
 * DKIM public keys) into adjacent quoted chunks separated by spaces, escaping embedded
 * backslashes and double quotes.
 */
export const formatCloudDnsTxt = (raw: string): string => {
  const chunks: Array<string> = [];
  let current = "";
  let currentBytes = 0;

  for (const ch of raw) {
    const escaped = ch === "\\" || ch === '"' ? `\\${ch}` : ch;
    const charBytes = Buffer.byteLength(ch, "utf8");
    if (currentBytes + charBytes > 255) {
      chunks.push(`"${current}"`);
      current = escaped;
      currentBytes = charBytes;
    } else {
      current += escaped;
      currentBytes += charBytes;
    }
  }
  chunks.push(`"${current}"`);
  return Arr.join(chunks, " ");
};

export const normalizeMxRrdata = (raw: string): string => {
  const trimmed = Str.trim(raw);
  const match = Option.getOrNull(Str.match(matchPattern)(trimmed));
  if (!(match !== null)) return trimmed;
  const priority = match[1];
  const host = Str.toLowerCase(match[2] ?? "");
  const fqdn = Str.endsWith(".")(host) ? host : `${host}.`;
  return `${priority} ${fqdn}`;
};

export const declareKvitbitDns = Effect.fn("KvitbitStack.declareDns")(function* (
  config: KvitbitStackConfig,
  dnsApi: ProjectService,
  edgeIpAddress: Output.Output<string | undefined> | undefined,
  mailIpAddress?: Output.Output<string | undefined> | undefined,
) {
  const { prefix } = resourceNames(config);
  const nameServers: Record<string, Output.Output<ReadonlyArray<string>, never>> = {};
  const edgeAddressData = edgeIpAddress?.pipe(
    Output.mapEffect((address) =>
      address === undefined || address === ""
        ? Effect.die(new Error("EdgeAddress has no IPv4 address for the Cloud DNS A records"))
        : Effect.succeed([address]),
    ),
  );
  const mailAddressData = mailIpAddress?.pipe(
    Output.mapEffect((address) =>
      address === undefined || address === ""
        ? Effect.die(
            new Error("KvitbitMailAddress has no IPv4 address for the Cloud DNS MX A record"),
          )
        : Effect.succeed([address]),
    ),
  );

  for (const domain of config.dnsZones) {
    const id = `DnsZone-${domain}`;
    const dnsName = `${domain}.`;
    const zone = yield* DNS.ManagedZone(id, {
      // A fresh plan must wait for API activation before reading or creating the zone.
      zoneName: dnsApi.state.pipe(Output.map(() => zoneNameFor(prefix, domain))),
      dnsName,
      description: `Kvitbit ${config.stage} public DNS for ${domain}`,
      visibility: "public",
      labels: stackLabels(config),
    });
    nameServers[domain] = zone.nameServers;

    if (edgeAddressData !== undefined) {
      yield* DNS.ResourceRecordSet(`${id}-ApexA`, {
        managedZone: zone.zoneName,
        name: dnsName,
        type: "A",
        ttl: 300,
        rrdatas: edgeAddressData,
      });
      yield* DNS.ResourceRecordSet(`${id}-WwwA`, {
        managedZone: zone.zoneName,
        name: `www.${dnsName}`,
        type: "A",
        ttl: 300,
        rrdatas: edgeAddressData,
      });
      yield* DNS.ResourceRecordSet(`${id}-ApexCaa`, {
        managedZone: zone.zoneName,
        name: dnsName,
        type: "CAA",
        ttl: 300,
        rrdatas: ['0 issue "pki.goog"', '0 issue "letsencrypt.org"'],
      });
    }

    if (config.mail !== undefined && domain === config.mail.domain) {
      const { mail } = config;
      if (mailAddressData !== undefined) {
        yield* DNS.ResourceRecordSet(`${id}-MailMxA`, {
          managedZone: zone.zoneName,
          name: `${mail.mxHost}.`,
          type: "A",
          ttl: 300,
          rrdatas: mailAddressData,
        });
        yield* DNS.ResourceRecordSet(`${id}-ApexMx`, {
          managedZone: zone.zoneName,
          name: dnsName,
          type: "MX",
          ttl: 300,
          rrdatas: [`10 ${mail.mxHost}.`],
        });
      }
      if (mail.resendDkimTxt !== undefined) {
        yield* DNS.ResourceRecordSet(`${id}-ResendDkimTxt`, {
          managedZone: zone.zoneName,
          name: `resend._domainkey.${dnsName}`,
          type: "TXT",
          ttl: 300,
          rrdatas: [formatCloudDnsTxt(mail.resendDkimTxt)],
        });
      }
      if (mail.resendSendMx !== undefined) {
        yield* DNS.ResourceRecordSet(`${id}-ResendSendMx`, {
          managedZone: zone.zoneName,
          name: `send.${dnsName}`,
          type: "MX",
          ttl: 300,
          rrdatas: [normalizeMxRrdata(mail.resendSendMx)],
        });
      }
      if (mail.resendSendSpfTxt !== undefined) {
        yield* DNS.ResourceRecordSet(`${id}-ResendSendSpfTxt`, {
          managedZone: zone.zoneName,
          name: `send.${dnsName}`,
          type: "TXT",
          ttl: 300,
          rrdatas: [formatCloudDnsTxt(mail.resendSendSpfTxt)],
        });
      }
      if (mail.apexSpfTxt !== undefined) {
        yield* DNS.ResourceRecordSet(`${id}-ApexSpfTxt`, {
          managedZone: zone.zoneName,
          name: dnsName,
          type: "TXT",
          ttl: 300,
          rrdatas: [formatCloudDnsTxt(mail.apexSpfTxt)],
        });
      }
      if (mail.dmarcTxt !== undefined) {
        yield* DNS.ResourceRecordSet(`${id}-DmarcTxt`, {
          managedZone: zone.zoneName,
          name: `_dmarc.${dnsName}`,
          type: "TXT",
          ttl: 300,
          rrdatas: [formatCloudDnsTxt(mail.dmarcTxt)],
        });
      }
    }
  }

  return nameServers;
});

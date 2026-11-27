// Alchemy resource names and instance props need a synchronous SHA-256. Effect Digest is asynchronous.
// @effect-diagnostics-next-line nodeBuiltinImport:off Alchemy constructs resource names synchronously from a Node SHA-256 digest.
import { createHash } from "node:crypto";
import * as DNS from "@alchemy.run/gcp/DNS";
import type { ProjectService } from "@alchemy.run/gcp/ServiceUsage";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Str from "effect/String";
import { type KvitbitStackConfig, resourceNames, stackLabels } from "../config";

const zoneNameFor = (prefix: string, domain: string) => {
  const slug = Str.replaceAll(".", "-")(domain);
  const hash = Str.slice(0, 12)(createHash("sha256").update(domain).digest("hex"));
  return `${prefix}-${Str.slice(0, 63 - prefix.length - hash.length - 2)(slug)}-${hash}`;
};

export const declareKvitbitDns = Effect.fn("KvitbitStack.declareDns")(function* (
  config: KvitbitStackConfig,
  dnsApi: ProjectService,
  edgeIpAddress: Output.Output<string | undefined> | undefined,
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
  }

  return nameServers;
});

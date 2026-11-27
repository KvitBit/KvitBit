import { createHash } from "node:crypto";
import * as DNS from "@alchemy.run/gcp/DNS";
import type { ProjectService } from "@alchemy.run/gcp/ServiceUsage";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import { type KvitbitStackConfig, resourceNames, stackLabels } from "../config";

const zoneNameFor = (prefix: string, domain: string) => {
  const slug = domain.replaceAll(".", "-");
  const hash = createHash("sha256").update(domain).digest("hex").slice(0, 12);
  return `${prefix}-${slug.slice(0, 63 - prefix.length - hash.length - 2)}-${hash}`;
};

export const declareKvitbitDns = Effect.fn("KvitbitStack.declareDns")(function* (
  config: KvitbitStackConfig,
  dnsApi: ProjectService,
  edgeIpAddress: Output.Output<string | undefined> | undefined,
) {
  const { prefix } = resourceNames(config);
  const nameServers: Record<string, Output.Output<ReadonlyArray<string>>> = {};
  const edgeAddressData = edgeIpAddress?.pipe(
    Output.map((address) => {
      if (!address) throw new Error("EdgeAddress has no IPv4 address for the Cloud DNS A records");
      return [address];
    }),
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

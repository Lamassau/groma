import { Chart, ChartProps, ApiObject } from "cdk8s";
import { Construct } from "constructs";

/**
 * MetalLB configuration chart.
 *
 * The MetalLB *operator* is installed via the official manifest
 * (see deploy-platform.sh). This chart only creates the
 * configuration resources: an IPAddressPool and an L2Advertisement.
 */

export interface MetalLBConfigChartProps extends ChartProps {
  /** Name for the IP pool */
  poolName: string;
  /** CIDR or range, e.g. "192.168.64.200-192.168.64.220" */
  addressRange: string;
}

export class MetalLBConfigChart extends Chart {
  constructor(
    scope: Construct,
    id: string,
    props: MetalLBConfigChartProps,
  ) {
    super(scope, id, props);

    const ns = props.namespace ?? "metallb-system";

    // IP address pool that MetalLB will hand out to LoadBalancer Services
    new ApiObject(this, "ip-pool", {
      apiVersion: "metallb.io/v1beta1",
      kind: "IPAddressPool",
      metadata: { name: props.poolName, namespace: ns },
      spec: {
        addresses: [props.addressRange],
      },
    });

    // Tell MetalLB to advertise pool IPs via ARP on the local L2 network
    new ApiObject(this, "l2-advertisement", {
      apiVersion: "metallb.io/v1beta1",
      kind: "L2Advertisement",
      metadata: { name: `${props.poolName}-l2`, namespace: ns },
      spec: {
        ipAddressPools: [props.poolName],
      },
    });
  }
}

import { ApiObject, Chart, ChartProps } from "cdk8s";
import { Construct } from "constructs";
import {
    ClusterRole,
    ClusterRoleBinding,
    Deployment,
    IngressClass,
    IntOrString,
    Namespace,
    Service,
    ServiceAccount,
} from "../k8s";

/**
 * Traefik ingress controller chart.
 *
 * Pre-requisite: Traefik CRDs must already be applied to the
 * cluster (the deploy-platform.sh script handles this).
 *
 * This chart creates:
 *   • traefik-system namespace
 *   • ServiceAccount, ClusterRole, ClusterRoleBinding
 *   • Deployment (with health checks)
 *   • LoadBalancer Service  (MetalLB assigns the IP)
 *   • A dashboard IngressRoute (traefik.<domain>)
 */

export interface TraefikChartProps extends ChartProps {
  /** Traefik container image */
  traefikImage?: string;
  /** Replica count */
  replicas?: number;
  /** Base domain for the dashboard IngressRoute */
  domain?: string;
  /** Namespaces Traefik should watch for ingress and CRD routes */
  watchNamespaces?: string[];
}

export class TraefikChart extends Chart {
  constructor(scope: Construct, id: string, props: TraefikChartProps) {
    super(scope, id, props);

    const ns = props.namespace ?? "traefik-system";
    const image = props.traefikImage ?? "traefik:v3.2";
    const labels = { app: "traefik" };
    const watchNamespaces =
      props.watchNamespaces && props.watchNamespaces.length > 0
        ? props.watchNamespaces.join(",")
        : undefined;

    // ── Namespace ──
    new Namespace(this, "ns", {
      metadata: { name: ns },
    });

    // ── RBAC ──
    new ServiceAccount(this, "sa", {
      metadata: { name: "traefik", namespace: ns },
    });

    new ClusterRole(this, "cr", {
      metadata: { name: "traefik" },
      rules: [
        {
          apiGroups: [""],
          resources: [
            "services",
            "endpoints",
            "secrets",
            "nodes",
            "namespaces",
          ],
          verbs: ["get", "list", "watch"],
        },
        {
          apiGroups: ["discovery.k8s.io"],
          resources: ["endpointslices"],
          verbs: ["get", "list", "watch"],
        },
        {
          apiGroups: ["extensions", "networking.k8s.io"],
          resources: ["ingresses", "ingressclasses"],
          verbs: ["get", "list", "watch"],
        },
        {
          apiGroups: ["extensions", "networking.k8s.io"],
          resources: ["ingresses/status"],
          verbs: ["update"],
        },
        {
          apiGroups: ["traefik.io"],
          resources: [
            "ingressroutes",
            "ingressroutetcps",
            "ingressrouteudps",
            "middlewares",
            "middlewaretcps",
            "serverstransports",
            "serverstransporttcps",
            "tlsoptions",
            "tlsstores",
            "traefikservices",
          ],
          verbs: ["get", "list", "watch"],
        },
      ],
    });

    new ClusterRoleBinding(this, "crb", {
      metadata: { name: "traefik" },
      roleRef: {
        apiGroup: "rbac.authorization.k8s.io",
        kind: "ClusterRole",
        name: "traefik",
      },
      subjects: [{ kind: "ServiceAccount", name: "traefik", namespace: ns }],
    });

    // ── IngressClass ──
    new IngressClass(this, "ingress-class", {
      metadata: { name: "traefik" },
      spec: {
        controller: "traefik.io/ingress-controller",
      },
    });

    // ── Deployment ──
    new Deployment(this, "deploy", {
      metadata: { name: "traefik", namespace: ns },
      spec: {
        replicas: props.replicas ?? 1,
        selector: { matchLabels: labels },
        template: {
          metadata: { labels },
          spec: {
            serviceAccountName: "traefik",
            containers: [
              {
                name: "traefik",
                image,
                args: [
                  "--api.dashboard=true",
                  "--api.insecure=true",
                  "--ping=true",
                  "--entrypoints.web.address=:80",
                  "--entrypoints.websecure.address=:443",
                  "--providers.kubernetescrd",
                  "--providers.kubernetescrd.allowCrossNamespace=true",
                  "--providers.kubernetesingress",
                  ...(watchNamespaces
                    ? [
                        `--providers.kubernetescrd.namespaces=${watchNamespaces}`,
                        `--providers.kubernetesingress.namespaces=${watchNamespaces}`,
                      ]
                    : []),
                  "--log.level=INFO",
                ],
                ports: [
                  { name: "web", containerPort: 80, protocol: "TCP" },
                  {
                    name: "websecure",
                    containerPort: 443,
                    protocol: "TCP",
                  },
                  {
                    name: "dashboard",
                    containerPort: 8080,
                    protocol: "TCP",
                  },
                ],
                readinessProbe: {
                  httpGet: {
                    path: "/ping",
                    port: IntOrString.fromNumber(8080),
                  },
                  initialDelaySeconds: 5,
                  periodSeconds: 10,
                },
                livenessProbe: {
                  httpGet: {
                    path: "/ping",
                    port: IntOrString.fromNumber(8080),
                  },
                  initialDelaySeconds: 15,
                  periodSeconds: 20,
                },
              },
            ],
          },
        },
      },
    });

    // ── Service (LoadBalancer — MetalLB assigns the external IP) ──
    new Service(this, "svc", {
      metadata: { name: "traefik", namespace: ns },
      spec: {
        type: "LoadBalancer",
        selector: labels,
        ports: [
          {
            name: "web",
            port: 80,
            targetPort: IntOrString.fromNumber(80),
            protocol: "TCP",
          },
          {
            name: "websecure",
            port: 443,
            targetPort: IntOrString.fromNumber(443),
            protocol: "TCP",
          },
          {
            name: "dashboard",
            port: 8080,
            targetPort: IntOrString.fromNumber(8080),
            protocol: "TCP",
          },
        ],
      },
    });

    // ── Dashboard IngressRoute (optional — traefik.<domain>) ──
    if (props.domain) {
      new ApiObject(this, "dashboard-route", {
        apiVersion: "traefik.io/v1alpha1",
        kind: "IngressRoute",
        metadata: { name: "traefik-dashboard", namespace: ns },
        spec: {
          entryPoints: ["web"],
          routes: [
            {
              match: `Host(\`traefik.${props.domain}\`)`,
              kind: "Rule",
              services: [{ name: "api@internal", kind: "TraefikService" }],
            },
          ],
        },
      });
    }
  }
}

import { Construct } from "constructs";
import { NetworkPolicy } from "../k8s";

export interface NamespaceNetworkPoliciesProps {
  namespace: string;
  appName: string;
  apiPort: number;
  webPort: number;
  mysqlPort?: number;
  mongoPort?: number;
  cachePort?: number;
}

/**
 * Applies a default-deny-all NetworkPolicy then explicit allow rules per service.
 *
 * Traffic model:
 *   Traefik  →  API, Web (ingress to app pods)
 *   Web      →  API        (frontend calls backend directly, optional)
 *   API      →  MySQL, MongoDB, Cache (backend accesses datastores)
 *   Backup   →  MySQL      (CronJob mysqldump)
 *   All pods →  kube-dns   (UDP/TCP 53, always required)
 *   All pods →  0.0.0.0/0  egress (S3 uploads, external APIs)
 */
export class NamespaceNetworkPolicies extends Construct {
  constructor(
    scope: Construct,
    id: string,
    props: NamespaceNetworkPoliciesProps,
  ) {
    super(scope, id);

    const { namespace, appName, apiPort, webPort } = props;
    const mysqlPort = props.mysqlPort ?? 3306;
    const mongoPort = props.mongoPort ?? 27017;
    const cachePort = props.cachePort ?? 6379;

    // Default-deny all ingress and egress within the namespace
    new NetworkPolicy(this, "default-deny", {
      metadata: {
        name: `${appName}-default-deny`,
        namespace,
      },
      spec: {
        podSelector: {},
        policyTypes: ["Ingress", "Egress"],
        egress: [
          // Allow DNS resolution (required for all pods)
          {
            ports: [
              { protocol: "UDP", port: 53 as any },
              { protocol: "TCP", port: 53 as any },
            ],
          },
        ],
      },
    });

    // Allow external egress for all pods (S3, external APIs, image pulls)
    new NetworkPolicy(this, "allow-external-egress", {
      metadata: {
        name: `${appName}-allow-external-egress`,
        namespace,
      },
      spec: {
        podSelector: {},
        policyTypes: ["Egress"],
        egress: [
          {
            to: [{ ipBlock: { cidr: "0.0.0.0/0", except: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"] } }],
          },
        ],
      },
    });

    // Allow Traefik to reach API pods
    new NetworkPolicy(this, "allow-traefik-to-api", {
      metadata: {
        name: `${appName}-allow-traefik-to-api`,
        namespace,
      },
      spec: {
        podSelector: { matchLabels: { "app.kubernetes.io/component": "api" } },
        policyTypes: ["Ingress"],
        ingress: [
          {
            from: [
              {
                namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "traefik-system" } },
                podSelector: { matchLabels: { app: "traefik" } },
              },
            ],
            ports: [{ port: apiPort as any, protocol: "TCP" }],
          },
        ],
      },
    });

    // Allow Traefik to reach Web pods
    new NetworkPolicy(this, "allow-traefik-to-web", {
      metadata: {
        name: `${appName}-allow-traefik-to-web`,
        namespace,
      },
      spec: {
        podSelector: { matchLabels: { "app.kubernetes.io/component": "frontend" } },
        policyTypes: ["Ingress"],
        ingress: [
          {
            from: [
              {
                namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "traefik-system" } },
                podSelector: { matchLabels: { app: "traefik" } },
              },
            ],
            ports: [{ port: webPort as any, protocol: "TCP" }],
          },
        ],
      },
    });

    // Allow API to reach MySQL
    new NetworkPolicy(this, "allow-api-to-mysql", {
      metadata: {
        name: `${appName}-allow-api-to-mysql`,
        namespace,
      },
      spec: {
        podSelector: { matchLabels: { "app.kubernetes.io/component": "mysql" } },
        policyTypes: ["Ingress"],
        ingress: [
          {
            from: [
              { podSelector: { matchLabels: { "app.kubernetes.io/component": "api" } } },
              { podSelector: { matchLabels: { component: "backup" } } },
            ],
            ports: [{ port: mysqlPort as any, protocol: "TCP" }],
          },
        ],
      },
    });

    // Allow API to reach MongoDB
    new NetworkPolicy(this, "allow-api-to-mongo", {
      metadata: {
        name: `${appName}-allow-api-to-mongo`,
        namespace,
      },
      spec: {
        podSelector: { matchLabels: { "app.kubernetes.io/component": "mongodb" } },
        policyTypes: ["Ingress"],
        ingress: [
          {
            from: [{ podSelector: { matchLabels: { "app.kubernetes.io/component": "api" } } }],
            ports: [{ port: mongoPort as any, protocol: "TCP" }],
          },
        ],
      },
    });

    // Allow API to reach cache (Redis/Valkey)
    new NetworkPolicy(this, "allow-api-to-cache", {
      metadata: {
        name: `${appName}-allow-api-to-cache`,
        namespace,
      },
      spec: {
        podSelector: { matchLabels: { "app.kubernetes.io/component": "cache" } },
        policyTypes: ["Ingress"],
        ingress: [
          {
            from: [{ podSelector: { matchLabels: { "app.kubernetes.io/component": "api" } } }],
            ports: [{ port: cachePort as any, protocol: "TCP" }],
          },
        ],
      },
    });

    // Allow API egress to datastores within the namespace
    new NetworkPolicy(this, "allow-api-egress-to-datastores", {
      metadata: {
        name: `${appName}-allow-api-egress-to-datastores`,
        namespace,
      },
      spec: {
        podSelector: { matchLabels: { "app.kubernetes.io/component": "api" } },
        policyTypes: ["Egress"],
        egress: [
          {
            to: [{ podSelector: { matchLabels: { "app.kubernetes.io/component": "mysql" } } }],
            ports: [{ port: mysqlPort as any, protocol: "TCP" }],
          },
          {
            to: [{ podSelector: { matchLabels: { "app.kubernetes.io/component": "mongodb" } } }],
            ports: [{ port: mongoPort as any, protocol: "TCP" }],
          },
          {
            to: [{ podSelector: { matchLabels: { "app.kubernetes.io/component": "cache" } } }],
            ports: [{ port: cachePort as any, protocol: "TCP" }],
          },
        ],
      },
    });
  }
}

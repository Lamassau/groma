export function appLabels(
  appName: string,
  component: string,
  extra?: Record<string, string>,
): Record<string, string> {
  return {
    "app.kubernetes.io/name": appName,
    "app.kubernetes.io/component": component,
    "app.kubernetes.io/managed-by": "cdk8s",
    "app.kubernetes.io/part-of": appName,
    ...extra,
  };
}

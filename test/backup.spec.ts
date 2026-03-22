import { App, Chart, Testing } from "cdk8s";
import { MariaDbBackup } from "../src/lib/constructs/backup";

describe("MariaDbBackup", () => {
  it("renders a CronJob with correct schedule and metadata", () => {
    const app = new App();
    const chart = new Chart(app, "test-chart");

    new MariaDbBackup(chart, "db-backup", {
      namespace: "futbalio-staging",
      appName: "futbalio",
      mysqlHost: "mysql-service",
      credentialsSecretName: "mysql-secret",
      s3Bucket: "futbalio-backups-staging",
      s3CredentialsSecretName: "futbalio-s3-credentials",
      retentionDays: 30,
      schedule: "0 2 * * *",
    });

    const manifests = Testing.synth(chart);
    const cronJob = manifests.find((m: any) => m.kind === "CronJob");

    expect(cronJob).toBeDefined();
    expect(cronJob.metadata.name).toBe("futbalio-db-backup");
    expect(cronJob.metadata.namespace).toBe("futbalio-staging");
    expect(cronJob.spec.schedule).toBe("0 2 * * *");
    expect(cronJob.spec.concurrencyPolicy).toBe("Forbid");
    expect(cronJob.spec.successfulJobsHistoryLimit).toBe(3);
    expect(cronJob.spec.failedJobsHistoryLimit).toBe(1);
  });

  it("defaults to daily 02:00 UTC schedule", () => {
    const app = new App();
    const chart = new Chart(app, "test-chart");

    new MariaDbBackup(chart, "db-backup", {
      namespace: "test-ns",
      appName: "futbalio",
      mysqlHost: "mysql-service",
      credentialsSecretName: "mysql-secret",
      s3Bucket: "my-bucket",
      s3CredentialsSecretName: "s3-creds",
    });

    const manifests = Testing.synth(chart);
    const cronJob = manifests.find((m: any) => m.kind === "CronJob");

    expect(cronJob.spec.schedule).toBe("0 2 * * *");
  });

  it("injects MySQL credentials from the specified secret", () => {
    const app = new App();
    const chart = new Chart(app, "test-chart");

    new MariaDbBackup(chart, "db-backup", {
      namespace: "test-ns",
      appName: "futbalio",
      mysqlHost: "mysql-service",
      credentialsSecretName: "my-mysql-secret",
      s3Bucket: "my-bucket",
      s3CredentialsSecretName: "my-s3-secret",
    });

    const manifests = Testing.synth(chart);
    const cronJob = manifests.find((m: any) => m.kind === "CronJob");
    const container = cronJob.spec.jobTemplate.spec.template.spec.containers[0];
    const envVars: any[] = container.env;

    const mysqlUser = envVars.find((e: any) => e.name === "MYSQL_USER");
    const mysqlPass = envVars.find((e: any) => e.name === "MYSQL_PASSWORD");
    const mysqlDb = envVars.find((e: any) => e.name === "MYSQL_DATABASE");

    expect(mysqlUser?.valueFrom?.secretKeyRef?.name).toBe("my-mysql-secret");
    expect(mysqlUser?.valueFrom?.secretKeyRef?.key).toBe("username");
    expect(mysqlPass?.valueFrom?.secretKeyRef?.name).toBe("my-mysql-secret");
    expect(mysqlPass?.valueFrom?.secretKeyRef?.key).toBe("password");
    expect(mysqlDb?.valueFrom?.secretKeyRef?.name).toBe("my-mysql-secret");
    expect(mysqlDb?.valueFrom?.secretKeyRef?.key).toBe("database");
  });

  it("injects S3 credentials from the specified secret", () => {
    const app = new App();
    const chart = new Chart(app, "test-chart");

    new MariaDbBackup(chart, "db-backup", {
      namespace: "test-ns",
      appName: "futbalio",
      mysqlHost: "mysql-service",
      credentialsSecretName: "mysql-secret",
      s3Bucket: "my-bucket",
      s3CredentialsSecretName: "my-s3-secret",
    });

    const manifests = Testing.synth(chart);
    const cronJob = manifests.find((m: any) => m.kind === "CronJob");
    const container = cronJob.spec.jobTemplate.spec.template.spec.containers[0];
    const envVars: any[] = container.env;

    const awsKey = envVars.find((e: any) => e.name === "AWS_ACCESS_KEY_ID");
    const awsSecret = envVars.find((e: any) => e.name === "AWS_SECRET_ACCESS_KEY");
    const awsRegion = envVars.find((e: any) => e.name === "AWS_DEFAULT_REGION");

    expect(awsKey?.valueFrom?.secretKeyRef?.name).toBe("my-s3-secret");
    expect(awsSecret?.valueFrom?.secretKeyRef?.name).toBe("my-s3-secret");
    expect(awsRegion?.valueFrom?.secretKeyRef?.name).toBe("my-s3-secret");
  });
});

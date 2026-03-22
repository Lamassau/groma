/**
 * Database Backup Constructs
 * Automated MariaDB backup CronJob using mysqldump + object storage upload
 */

import { Construct } from "constructs";
import { CronJob } from "../k8s";

export interface MariaDbBackupProps {
  /** Kubernetes namespace */
  namespace: string;
  /** Application name (used for labelling) */
  appName: string;
  /**
   * Cron schedule for the backup job.
   * Defaults to "0 2 * * *" (daily at 02:00 UTC).
   */
  schedule?: string;
  /** MariaDB host (Kubernetes service name) */
  mysqlHost: string;
  /** MariaDB port (default: 3306) */
  mysqlPort?: number;
  /** Name of the Kubernetes Secret that holds MySQL credentials.
   *  Expected keys: `username`, `password`, `database`
   */
  credentialsSecretName: string;
  /**
   * S3-compatible bucket name to store backups.
   * Example: "futbalio-backups"
   */
  s3Bucket: string;
  /**
   * S3-compatible endpoint URL.
   * Leave empty for AWS S3.  Set for MinIO / Ceph / R2:
   *   "https://s3.example.com"
   */
  s3Endpoint?: string;
  /**
   * Name of the Kubernetes Secret containing S3 credentials.
   * Expected keys: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`
   */
  s3CredentialsSecretName: string;
  /**
   * Number of days to retain backups in S3.
   * Older backups are deleted after this many days via a lifecycle rule.
   * The CronJob itself also prunes local copies.
   * Defaults to 30.
   */
  retentionDays?: number;
  /** Container image for the backup job.
   *  Must have both the AWS CLI and the MariaDB client available (or install them at runtime).
   *  Defaults to a pinned `amazon/aws-cli` image; mariadb-client is installed at job start.
   *  Pin this to a specific digest in production for fully reproducible backups.
   *  Example: "amazon/aws-cli:2.17.0"
   */
  image?: string;
}

/**
 * MariaDbBackup construct.
 *
 * Deploys a Kubernetes CronJob that:
 *  1. Runs `mysqldump` against the target MariaDB instance
 *  2. Compresses the dump with gzip
 *  3. Uploads the compressed file to S3-compatible object storage via the
 *     AWS CLI (aws s3 cp)
 *  4. Optionally removes local dump files (container is ephemeral anyway)
 *
 * Backup filenames follow the pattern:
 *   futbalio/<YYYY-MM-DD>/backup-<YYYY-MM-DDTHH-MM-SS>.sql.gz
 *
 * Prerequisites:
 *  - Kubernetes Secret with MySQL credentials (credentialsSecretName)
 *  - Kubernetes Secret with S3 credentials (s3CredentialsSecretName)
 *  - S3 bucket must already exist; lifecycle rules for retention should be
 *    configured at the bucket level (30-day expiry recommended)
 */
export class MariaDbBackup extends Construct {
  constructor(scope: Construct, id: string, props: MariaDbBackupProps) {
    super(scope, id);

    const image = props.image ?? "amazon/aws-cli:2.17.0";
    const schedule = props.schedule ?? "0 2 * * *";
    const retentionDays = props.retentionDays ?? 30;
    const mysqlPort = props.mysqlPort ?? 3306;
    const s3Endpoint = props.s3Endpoint ?? "";

    // Build the backup shell script
    const backupScript = [
      "set -euo pipefail",
      'TIMESTAMP=$(date +"%Y-%m-%dT%H-%M-%S")',
      'DATE=$(date +"%Y-%m-%d")',
      'FILENAME="backup-${TIMESTAMP}.sql.gz"',
      'S3_KEY="${APP_NAME}/${DATE}/${FILENAME}"',
      "",
      "echo \"Starting MariaDB backup: ${FILENAME}\"",
      "",
      // Dump and compress in a single pipeline
      "mysqldump \\",
      `  -h "${props.mysqlHost}" \\`,
      `  -P "${mysqlPort}" \\`,
      '  -u "${MYSQL_USER}" \\',
      '  -p"${MYSQL_PASSWORD}" \\',
      "  --single-transaction \\",
      "  --quick \\",
      "  --lock-tables=false \\",
      '  "${MYSQL_DATABASE}" \\',
      '  | gzip > "/tmp/${FILENAME}"',
      "",
      "echo \"Dump complete. Uploading to s3://${S3_BUCKET}/${S3_KEY}\"",
      "",
      // Upload to S3
      ...(s3Endpoint
        ? [`AWS_CLI_OPTS="--endpoint-url ${s3Endpoint}"`]
        : ["AWS_CLI_OPTS="]),
      'aws s3 cp "/tmp/${FILENAME}" "s3://${S3_BUCKET}/${S3_KEY}" ${AWS_CLI_OPTS}',
      "",
      "echo \"Backup uploaded successfully.\"",
      "",
      // Optional: prune local temp file (container is ephemeral, but keeps it clean)
      'rm -f "/tmp/${FILENAME}"',
      "",
      // Prune old backups beyond retention window
      `echo "Pruning backups older than ${retentionDays} days..."`,
      `CUTOFF=$(date -d "-${retentionDays} days" +"%Y-%m-%d" 2>/dev/null || date -v -${retentionDays}d +"%Y-%m-%d")`,
      'aws s3 ls "s3://${S3_BUCKET}/${APP_NAME}/" ${AWS_CLI_OPTS} \\',
      "  | awk '{print $2}' \\",
      '  | while read prefix; do',
      "    folder=${prefix%/}",
      '    if [[ "$folder" < "$CUTOFF" ]]; then',
      '      echo "Deleting old backup folder: ${folder}"',
      '      aws s3 rm "s3://${S3_BUCKET}/${APP_NAME}/${folder}/" --recursive ${AWS_CLI_OPTS}',
      "    fi",
      "  done",
      "",
      "echo \"Backup complete.\"",
    ].join("\n");

    new CronJob(this, "backup-cronjob", {
      metadata: {
        name: `${props.appName}-db-backup`,
        namespace: props.namespace,
        labels: {
          app: `${props.appName}-db-backup`,
          component: "backup",
          "app.kubernetes.io/part-of": props.appName,
        },
      },
      spec: {
        schedule,
        // Keep 3 successful and 1 failed job for debugging
        successfulJobsHistoryLimit: 3,
        failedJobsHistoryLimit: 1,
        // Prevent overlapping backups
        concurrencyPolicy: "Forbid",
        jobTemplate: {
          spec: {
            // Retry once on failure
            backoffLimit: 1,
            template: {
              spec: {
                restartPolicy: "OnFailure",
                containers: [
                  {
                    name: "backup",
                    // Use props.image (default: pinned amazon/aws-cli) so callers
                    // can supply their own image.  mariadb-client is installed at
                    // job start for AWS-CLI-based images that lack it by default.
                    image,
                    command: ["/bin/bash", "-c"],
                    args: [
                      // Install mariadb-client at runtime (small, one-shot pod)
                      "yum install -y mariadb 2>/dev/null || apk add --no-cache mariadb-client 2>/dev/null || true\n" +
                        backupScript,
                    ],
                    env: [
                      {
                        name: "APP_NAME",
                        value: props.appName,
                      },
                      {
                        name: "S3_BUCKET",
                        value: props.s3Bucket,
                      },
                      {
                        name: "MYSQL_USER",
                        valueFrom: {
                          secretKeyRef: {
                            name: props.credentialsSecretName,
                            key: "username",
                          },
                        },
                      },
                      {
                        name: "MYSQL_PASSWORD",
                        valueFrom: {
                          secretKeyRef: {
                            name: props.credentialsSecretName,
                            key: "password",
                          },
                        },
                      },
                      {
                        name: "MYSQL_DATABASE",
                        valueFrom: {
                          secretKeyRef: {
                            name: props.credentialsSecretName,
                            key: "database",
                          },
                        },
                      },
                      {
                        name: "AWS_ACCESS_KEY_ID",
                        valueFrom: {
                          secretKeyRef: {
                            name: props.s3CredentialsSecretName,
                            key: "AWS_ACCESS_KEY_ID",
                          },
                        },
                      },
                      {
                        name: "AWS_SECRET_ACCESS_KEY",
                        valueFrom: {
                          secretKeyRef: {
                            name: props.s3CredentialsSecretName,
                            key: "AWS_SECRET_ACCESS_KEY",
                          },
                        },
                      },
                      {
                        name: "AWS_DEFAULT_REGION",
                        valueFrom: {
                          secretKeyRef: {
                            name: props.s3CredentialsSecretName,
                            key: "AWS_REGION",
                          },
                        },
                      },
                    ],
                  },
                ],
              },
            },
          },
        },
      },
    });
  }
}

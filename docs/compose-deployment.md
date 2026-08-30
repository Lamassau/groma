# DigitalOcean / plain-host deployment

## 1. Prepare access

Create an Ubuntu 22.04 or 24.04 LTS droplet yourself. Use a trusted SSH account, verify the server host key through an independent channel, and add it to your local known_hosts. GROMa always uses StrictHostKeyChecking=yes and BatchMode=yes; it will not accept a new key blindly or prompt for passwords.

The host setup command needs existing passwordless sudo. It adds the existing account to docker and groma groups, but never creates an account or grants sudo rights. The deployment account needs Docker access, write access to `/opt/groma`, and non-interactive sudo for Caddy validation, route installation/removal and systemctl reload. Docker access is effectively root access: use this only with trusted administrators. Do not expose the Docker API or socket.

Using an existing administrative account with `sudo -n` is the simplest initial setup. For restricted sudo rules, have an administrator review the generated script's exact commands; granting arbitrary `install`, `rm` or shell execution is not a safe least-privilege policy. A hardened server-side privileged helper is outside this initial version.

## 2. Review host setup

`groma host setup` prints without changing the server. `--execute --yes --expect-target <configured-user@host>` runs it.

The script:

- Checks Ubuntu version and refuses an unrelated existing Caddy configuration.
- Installs Docker/Compose and Caddy from their official package sources if absent.
- Does not replace an existing incompatible Docker installation automatically.
- Creates `/opt/groma` and `/etc/caddy/groma`; initializes the Caddy import.
- Enables Docker/Caddy systemd services.
- Preserves existing UFW rules, permits the configured SSH port and TCP 80/443, sets incoming default deny/outgoing allow, and enables UFW.

Review existing firewall use before execution: this is intended for a dedicated/new host, not an arbitrary multi-purpose server. Keep DigitalOcean console access available. Do not close an existing SSH session until a fresh connection succeeds. Reconnect to pick up new group membership.

For an already prepared server, skip setup. Create the directories with appropriate ownership and add this exact line to the managed Caddyfile:

```caddy
import /etc/caddy/groma/*.caddy
```

Then run `groma doctor`. No paid DigitalOcean API service or Kubernetes cluster is required.

## 3. Images, secrets and DNS

Build and push the app image outside GROMa. Authenticate the deployment account to a private registry on the droplet independently; credentials remain in that account's Docker configuration. Do not place registry credentials in groma.yaml.

Provision application secret files separately with restrictive permissions. See configuration.md for file mounts and `_FILE` variables.

Point each public domain at the droplet and permit 80/443 through the cloud firewall. Certificates depend on publicly reachable, correct DNS. GROMa does not change DNS records or verify external HTTPS itself.

Docker-published ports can bypass UFW rules. GROMa publishes only loopback ports and never exposes database ports. Require a current Docker Engine (28 or newer) for localhost publishing isolation fixes; verify cloud firewall rules as defense in depth. See Docker's [firewall documentation](https://docs.docker.com/engine/network/packet-filtering-firewalls/) and [port publishing documentation](https://docs.docker.com/engine/network/port-publishing/).

## 4. Deploy and inspect

Run validate, doctor, plan, then deploy with the explicit target. Plan is read-only. Compose plan compares the requested Compose file to the last successful GROMa file; it is not a live drift detector and cannot detect a changed registry tag. It does not currently show a separate proxy-file diff, although domains and loopback ports are reported/configured in the project.

Deployment holds a host-wide lock, checks domain/port ownership, rejects an unmanaged same-name Compose project, creates a private release directory, validates Compose, resolves image digests into an override, pulls images, and waits for health checks (120 seconds). It updates Caddy only after services are healthy, validates and reloads the proxy, then atomically advances the current symlink.

Registry digest resolution fails closed. Releases retain the locked image references, so later tag changes do not change rollback images. The release.json records the original requested images; images.lock.yaml is the authoritative resolved set. Secrets remain references to mutable external files, not snapshots.

A failure attempts to recover the prior app and proxy configuration, and never advances current. Recovery itself may fail and is reported. A failed first deployment stops its containers without deleting named volumes. Updates are in place, not blue/green; brief downtime is possible. Shell traps cannot recover from SIGKILL or host failure. Inspect actual state after an interrupted deployment.

## 5. Recovery and data

```bash
groma rollback --yes --expect-target deploy@your-host
```

Rollback reuses the previous successful release. It does not roll back migrations, database contents, secret files or other external dependencies. Use backward-compatible migrations. Back up and test restoration separately before production.

Successful releases live under `/opt/groma/<app>-<environment>/releases`, with current and previous symlinks. Release pruning is manual in this version: preserve current and previous, and do not delete named volumes. Application log output may contain secrets; GROMa does not pretend it can reliably redact arbitrary application logs.

## Live acceptance checklist

Before treating the droplet deployment as verified:

1. Run doctor on a freshly prepared supported Ubuntu host.
2. Deploy two sample apps with different domains/ports; verify both HTTPS URLs externally.
3. Confirm database ports are inaccessible externally and cross-project networks are distinct.
4. Upgrade one image; confirm only that project changes.
5. Introduce a failing healthcheck; verify previous release and proxy recovery.
6. Exercise rollback and confirm named-volume data survives.
7. Reboot the droplet; verify Docker containers and Caddy recover.
8. For production data, perform an off-host backup and an actual restore drill.

Local mock tests and CI container tests do not replace this SSH/systemd/ACME acceptance checklist.

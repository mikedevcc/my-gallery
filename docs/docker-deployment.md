# Docker NAS deployment example (Debian 13)

This supplements [production deployment](deployment.md) and [storage configuration](storage-configuration.md). It documents the tested topology; commands and paths are **examples to adapt and verify**, not an automated installer. Do not apply the example to an existing installation without reviewing its database and mounts.

## Topology and prerequisites

- Debian 13 with Docker Engine, Docker Compose, systemd, Python 3 and util-linux (`blkid`).
- PostgreSQL 17 in a Docker named volume on host persistent storage, without publishing port 5432.
- Next.js standalone image on Node 24 as an unprivileged user with ExifTool, FFmpeg and Sharp.
- A manually mounted ext4/XFS volume, with a stable `/etc/fstab` UUID entry, an administrator-reviewed installation marker and a writable gallery directory. Never create a replacement media root if the mount is missing.
- Root-only configuration under `/etc/mygallery`; a root-controlled Compose file and host scripts under `/usr/local/libexec/mygallery`.
- A read-only bind mount of the *directory* containing the host-generated assertion, separate from the writable media mount.

The running NAS was tested with application localhost binding (`127.0.0.1:3000`), PostgreSQL reachable only on the Compose backend, and `GEOCODER_MODE=disabled`. It uses separate `gallery_admin`, `gallery_migrator`, and `gallery_app` PostgreSQL roles. The app role has DML on application tables but no DDL or access to `schema_migrations`.

## Configuration

See [`../deploy/compose.yaml.example`](../deploy/compose.yaml.example) for a non-secret **illustrative** Compose layout. The actual deployment uses a root-owned `/etc/mygallery/compose.yaml` and root-owned environment files; this repository does **not** include them.

Keep real secrets **out of Git**, Docker build contexts, command lines and screenshots:

- `/etc/mygallery/postgres.env`: PostgreSQL initial administrator credentials (not application credentials).
- `/etc/mygallery/migration.env`: explicit `GALLERY_MIGRATION_URL` for approved migration commands only.
- `/etc/mygallery/app.env`: URL-encoded `DATABASE_URL` for `gallery_app`; Docker storage mode/UUID/installation ID/assertion path; geocoder mode.

Do not give the gallery container administrator or migration credentials. Migration SQL is applied through the separate runner and never during app startup. Follow [`../db/migrations/README.md`](../db/migrations/README.md) for `plan`, `init`/`up`, and `status`; review the target and back up before changes. Do not run `init` on an existing database.

## Storage startup lifecycle

The deployed host uses these **administrator-managed** systemd units:

| Unit | Responsibility |
| --- | --- |
| `mygallery.service` | Run host USB preflight before starting Gallery; stop only Gallery on shutdown |
| `mygallery-renew.service` and `.timer` | Stop Gallery, run preflight, then restart only if verification succeeds; scheduled approximately every 12 hours |
| `mygallery-watchdog.service` and `.timer` | Re-verify the host storage and Docker mount while Gallery is active, approximately once per minute; stop Gallery on failure |

The host preflight checks real block-device identity, the mounted filesystem and the installation marker, and writes an assertion outside the media filesystem. Its output is valid for at most 24 hours. A watchdog must use a **separate temporary assertion destination**, because preflight deletes the target output before probing. Renewal and watchdog operations must be serialized with a host lock. Neither may bypass a failed check or silently create a new installation marker.

The production scripts and units were installed directly on the NAS and must be reviewed, generalized, and committed as sanitized templates before claiming a fully reproducible deployment. This example does not promise that cloning the repository alone reproduces those services.

### Non-destructive checks on an existing installation

```bash
systemctl is-active mygallery.service
systemctl list-timers --all 'mygallery-*'
docker compose -f /etc/mygallery/compose.yaml ps
curl -I --max-time 10 http://127.0.0.1:3000/
```

A `200 OK` response to the prerendered homepage does not prove database or storage operations. Test a disposable photo import and retrieval separately after appropriate backups and permissions verification.

## Access model

Gallery's published host port must remain `127.0.0.1:3000:3000`. From a trusted device on the LAN:

```bash
ssh -N -L 3000:127.0.0.1:3000 <nas-user>@<nas-lan-address>
```

Then browse `http://127.0.0.1:3000` on that device. Alternatively, use **Tailscale Serve**, which proxies the NAS loopback app to authorized tailnet devices over HTTPS. Do not enable Tailscale Funnel, direct LAN-wide publication, or public port-forwarding unless independent application authentication and access controls have been designed.

## Maintenance and backup

- Back up both PostgreSQL and the filesystem media library, including restoration/recovery evidence. Test restore procedures before depending on them.
- Preserve historical SQL migration checksums; do not edit applied SQL versions.
- When updating images, rebuild and test a new image tag first. Stop Gallery, run the preflight and controlled startup path, and verify the runtime image and media tools before discarding the older image.
- Keep `restart: "no"` for Gallery so Docker does not bypass host preflight. Never mount `/dev/disk` or Docker's socket into the unprivileged Gallery container.
- Avoid `docker volume prune` and `docker system prune --volumes`; the PostgreSQL named volume contains user data.

Known limitation: systemd oneshot status represents successful orchestration, not ongoing container health. The watchdog supplies periodic checks but cannot prevent every filesystem race or data loss caused by sudden USB removal.

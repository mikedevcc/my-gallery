# My Gallery

A private, self-hosted photo and video library built with Next.js, React, TypeScript, PostgreSQL and Docker.

My Gallery organizes media by trips, albums and location. It is designed for a personal NAS, with a focus on storage identity checks, recoverability and keeping photos under the owner's control.

## Current features (v0.1.0)

- Browse photos and videos, trips, albums and favorites.
- Import media and extract available metadata using ExifTool.
- View originals and thumbnails; video playback depends on browser codec support.
- Organize media into albums and trips and use available location metadata.
- Track schema changes using reviewed PostgreSQL SQL migrations.
- Validate the configured storage filesystem before media operations.

**Not implemented as production views:** search, recently added, dedicated videos, screenshots and trash. Those routes are deferred. There is no application-level login or user authorization.

## Technology

- Next.js 16 App Router, React 19, TypeScript and Tailwind CSS
- PostgreSQL 17 via `pg`, with versioned SQL migrations in `db/migrations/`
- Node.js 24, Sharp, ExifTool and FFmpeg
- Docker Compose on Debian 13; systemd controls verified-storage startup on the NAS

Historical Prisma files are not the active migration system. **Do not run Prisma migrations against this database.**

## Development

Prerequisites: Node.js 24 and npm; a separately configured PostgreSQL 17 database and approved media storage are needed for live data operations.

```bash
npm ci
npm run dev
```

Open <http://localhost:3000>. The development server does not provision a database, configure geocoding, or create safe media storage automatically. Start with [`.env.example`](.env.example), [server prerequisites](docs/server-prerequisites.md) and [storage configuration](docs/storage-configuration.md).

```bash
npm run lint
npx tsc --noEmit
npm run build
npm audit --omit=dev
```

For migration commands and rules, see [SQL migrations](db/migrations/README.md). The migration runner uses a separate maintenance database identity and never runs automatically at application startup.

## Deploying on a NAS

See the [Docker deployment guide](docs/docker-deployment.md) for a reproducible **example configuration** and the [production deployment reference](docs/deployment.md) for detailed operational constraints. The supplied Compose example is not a drop-in replacement for an existing installation.

The tested setup uses Debian 13, Docker Compose, PostgreSQL 17, a separately mounted ext4 USB filesystem, and systemd-managed host storage preflight, renewal and watchdog checks. The Gallery container runs as an unprivileged user, with the media directory mounted from the host and a read-only storage assertion directory.

**Access:** The app is intentionally bound to NAS loopback (`127.0.0.1:3000`). Access it over a local SSH tunnel, or privately using Tailscale Serve. Do **not** use Tailscale Funnel or forward the app's port to the public internet: v0.1.0 has no authentication or authorization.

## Data safety and limitations

- Database data, original media, thumbnails and recovery evidence require coordinated backups; Docker volumes are not backups.
- Storage identity checks reduce wrong-disk and missing-mount risks but cannot guarantee recovery from sudden device removal, hardware failure or interrupted operations.
- Destructive media actions exist: restrict access to trusted users and keep independent backups.
- Geocoding is optional and explicitly configured; there is no implicit public geocoder fallback.

## Documentation

- [Docker deployment walkthrough](docs/docker-deployment.md)
- [Production deployment reference](docs/deployment.md)
- [Server prerequisites](docs/server-prerequisites.md)
- [Storage provisioning and validation](docs/storage-configuration.md)
- [Versioned SQL migration procedures](db/migrations/README.md)
- [Supported media formats](docs/media-formats.md)
- [Media processing limits](docs/processing-limits.md)

## Release status

v0.1.0 is a single-user self-hosted application. New deployments require explicit review of database permissions, storage identity, systemd units and access restrictions. Do not reuse another installation's credentials or filesystem identity.

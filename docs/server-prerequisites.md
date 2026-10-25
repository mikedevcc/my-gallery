# Server prerequisites

See [production deployment](deployment.md) for configuration, startup checks,
release order and maintenance environments.

- Debian with one Next.js Node process (Node 24 tested) and npm.
- PostgreSQL 17, provisioned using reviewed versioned SQL migrations.
- Local ext4/XFS HDD with administrator-created installation marker and UUID mount;
  see [storage configuration](storage-configuration.md).
- ExifTool and FFmpeg available on the service PATH.
- Sharp installed as a direct npm runtime dependency, including its platform/native
  packages. No separate Sharp CLI is required.
- Nominatim-compatible reverse-geocoding service only when enabled. Its own PostGIS,
  OSM import tools, Python and data storage are managed separately; they are not
  gallery-schema requirements. The application has no default development URL.
- PostgreSQL 17 client tools (`pg_dump`, and `psql` for operator procedures) plus
  a maintenance checkout containing `tsx` for migration/recovery commands.

This list does not provision services, initialize storage, or run migrations.

### Docker deployment prerequisites (Debian 13)

The tested NAS deployment uses Docker Engine, Docker Compose, a Next.js standalone image running Node.js 24, and PostgreSQL 17.

**Host requirements**
- Debian 13 with Docker Engine, Docker Compose and systemd.
- A separately mounted writable ext4/XFS filesystem for media storage.
- Python 3 and util-linux (`blkid`) for host-side storage verification.
- Root-controlled storage preflight, systemd startup, renewal, and watchdog services.
- A protected directory for database credentials and application configuration.

**Application container requirements**
- Node.js 24.
- ExifTool and FFmpeg.
- Sharp and its native dependencies.
- A non-root runtime user with permission to access the media bind mount.

**Database and maintenance**
- PostgreSQL 17 in a separate container with persistent storage.
- A restricted application database role and separate migration role.
- Node.js, `tsx` and `pg` for migration execution.
- PostgreSQL client utilities for backup, restore and migration verification.

**Networking and access**
- Bind the application to `127.0.0.1` on the NAS.
- Access it using an SSH tunnel or private Tailscale Serve configuration.
- Do not enable Tailscale Funnel or expose the application publicly without an appropriate authentication and authorization layer.

The application does not automatically provision disks, initialize installation markers, create database roles, or apply database migrations.
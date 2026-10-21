# Production deployment on Debian

Use one Next.js Node process, PostgreSQL 17 and an independently provisioned,
locally mounted ext4/XFS HDD. Node 24 is the tested runtime. Install from the
committed lockfile with npm; preserve native optional platform packages needed by
Sharp. `sharp` is an explicit runtime dependency, not an accidental Next dependency.
ExifTool (`libimage-exiftool-perl` on Debian) and FFmpeg (`ffmpeg`) must be on the
service user's PATH. FFprobe is included with FFmpeg but is not currently invoked.
A separately hosted Nominatim-compatible service is required only when geocoding
is enabled. PostGIS, osm2pgsql, Python/venv and OSM imports are requirements of
that service's installation, not of the gallery database or Node application.
Follow the chosen Nominatim version's own production instructions; its development
server is not a deployment default.

Sharp uses its native libvips/platform package; verify that the target Debian CPU
and libc have supported binaries, or provision the documented native build tools.

## Environment and boundaries

Copy [.env.example](../.env.example) to an **untracked**, permission-restricted
configuration file and replace every placeholder. Never copy a working deployment's
credentials or storage identity to a different installation. Next loads its usual
`.env*` files; a service manager may instead supply environment variables, which
take precedence. Do not assume systemd EnvironmentFile has identical syntax to
dotenv, especially for `$`, quotes and escapes. URL-encode database credentials.
No secret belongs in a `NEXT_PUBLIC_*` variable, command-line URL or committed file.

Next's instrumentation hook validates configuration before serving requests, without
checking out a database client, inspecting media, probing the HDD, calling a service,
or executing migrations/recovery. Importing the database module also makes no
connection. Its first checkout validates DATABASE_URL again; changing a live pool's
target requires an application restart. Connection establishment has a five-second
timeout. This does not impose query/transaction timeouts or prove permissions,
schema readiness or server availability. For remote PostgreSQL, select the intended TLS mode and install the trusted CA
for Node (for example via the service's `NODE_EXTRA_CA_CERTS`); never disable Node
certificate verification to bypass a configuration error.
Configuration errors name variables and
requirements and do not echo supplied values. Runtime fetch errors are sanitized.

Storage **configuration** is checked at startup. Existing marker, mount, device,
path and destination-lock checks still run at each relevant operation: a successful
startup check is never authorization to use a missing HDD. Follow
[storage provisioning](storage-configuration.md) to create the installation marker
manually and configure the Debian UUID mount. Neither startup nor the environment
example provisions a database, mount, directory, marker or migration ledger.

| Variable | Requirement/default |
| --- | --- |
| `DATABASE_URL` | Required explicit `postgresql://ROLE:PASSWORD@HOST:PORT/DATABASE` (also accepts `postgres:`). Role, host, port and database must be explicit. Password may be omitted for intentionally configured external authentication. No ambient PGHOST/PGPORT/PGDATABASE defaults. Only optional `sslmode=disable`, `require`, `verify-ca` or `verify-full` query values are accepted; no target overrides. |
| `MEDIA_STORAGE_ROOT` | Required absolute existing media directory, excluding filesystem root, control characters and symlink roots; no fallback or automatic creation. |
| `MEDIA_STORAGE_UUID` | Required UUID of the expected mounted filesystem. |
| `MEDIA_STORAGE_ID` | Required independent installation UUID matching the administrator-provisioned marker. |
| `GEOCODER_MODE` | `required` (default), `best-effort`, or `disabled`. |
| `GEOCODER_URL` | Required unless disabled. Complete HTTP(S) Nominatim-compatible **reverse endpoint**, e.g. `https://geocoder.example.invalid/reverse`; no credentials, query or fragment. This is a placeholder, not a public service default. |
| `GEOCODER_TIMEOUT_MS` | 10000; positive decimal integer, at most 2147483647. Includes response-body consumption. |
| `PORT` | Next's HTTP port; defaults to 3000. Set in the service/shell environment or pass `--port`, not in .env (HTTP startup precedes .env loading). Use an explicit `--hostname` binding. |

Geocoder `required` preserves prior import behavior: transport, HTTP, malformed
response, output-limit or deadline failure aborts preprocessing before publication.
Responses are capped at 64 KiB; timeouts return 504 and service failures 502 without
URLs/response bodies. `best-effort` uses no location after service failure; `disabled`
never fetches. Both can produce the existing `Unknown` destination location when
GPS is present. This is a deliberate operator choice affecting new destination
paths and duplicate detection; no existing record or file is renamed. Configuration
errors always fail, including in best-effort mode. Cancellation always aborts active
lookups even in best-effort mode. Successful lookups without a supported address
continue to yield no location, as before. No silent public-geocoder fallback exists.
A custom endpoint must implement Nominatim's `lat`, `lon`, `format=jsonv2`,
`addressdetails=1` and string-valued address fields. Restrict who can edit this
server-only URL; it is trusted installation configuration, not request input.

All H4/M13 variable names remain unchanged. See [processing limits](processing-limits.md)
for the full byte, concurrency, pixel, output and deadline defaults. Numeric values
are positive decimal safe integers; empty strings are invalid, not aliases for
unset values. Request limits must cover upload limits; upload/subprocess timer
values must fit Node's 2147483647 ms timer range. No database/storage variable is
optional simply because a geocoder or processing limit has a default.

## Build and release

1. Provision PostgreSQL and storage separately, with a tested backup of database,
   media and recovery evidence. Give the application role the table/sequence
   permissions needed by the current schema, including receipt insertion and
   receipt lookup; reserve DDL for a separate migration role.
2. Review and apply pending versioned SQL using the [migration runner procedure](../db/migrations/README.md)
   and an explicit maintenance target. For existing installations, use its verified,
   explicitly approved adoption workflow rather than replaying the baseline.
   Never run Prisma migrate/db push. Stop media writes across schema/application
   rollout boundaries; keep receipts, retained locks and journals together.
3. On a build host with appropriate configuration, run `npm ci`, TypeScript, lint,
   tests, and `npm run build`. Keep runtime secrets out of source/build logs. Then
   `npm start -- --hostname 127.0.0.1` on the Debian service host behind the intended
   proxy. No build, server start or test was performed against a real database as
   part of M12 verification. Review any future server prerender/data-fetching code
   before giving a build host database access.
4. Supply the service environment and a PATH containing Node, ExifTool and FFmpeg;
   use a dedicated unprivileged service account with storage ownership and access
   to `/proc/self/mountinfo` and `/dev/disk/by-uuid`. Use an explicit service working
   directory for the installation, not a developer's home. Configure mount ordering
   (`RequiresMountsFor` and the UUID mount) so the HDD is available before serving.
   Runtime validation still refuses a missing or changed device.
5. Put the service behind your intended TLS/access-control layer or private network;
   this configuration change does not add application authentication. API mutation
   endpoints must not be exposed to untrusted clients without access control.
   Match proxy request/time/temp-storage limits to [M13](processing-limits.md).
   Resource admissions are per Node process; use one process plus systemd/OS resource
   limits and filesystem quotas where hard caps are required.

`GALLERY_MIGRATION_URL` belongs only to the explicit migration CLI environment;
`MEDIA_RECOVERY_DATABASE_URL` belongs only to the explicit manual recovery CLI
with its target/installation confirmations. Neither CLI automatically loads .env
or uses DATABASE_URL as a substitute for its explicit target. Their target checks
and applied SQL remain unchanged. CLI execution uses `tsx`, currently a development
dependency: keep a separate maintenance checkout/install with dev dependencies if
production runs `npm ci --omit=dev`. Do not introduce maintenance credentials into
the ordinary application service environment. See [replacement recovery](replacement-recovery.md)
and [deletion recovery](deletion-tracking.md) for operational recovery.

The legacy Prisma helper/client is retained for reference and has no active
application callers; SQL migrations remain authoritative. Development import
scripts now require explicit media-file arguments. They perform real imports and
are not offline tests; do not run them as deployment validation. Demonstration
images/UI data remain separate from this production configuration work.

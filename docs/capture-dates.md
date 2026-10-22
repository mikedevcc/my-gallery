# Capture dates and timezones (M11-A)

## Policy

Capture wall time, timezone knowledge, a known instant and import time are separate
facts. A camera's explicit offset is respected; an offsetless camera timestamp is
not assumed to be in the server timezone, UTC, a GPS-derived timezone or the browser
timezone. No implicit UTC assumption is made for `CreateDate`, including QuickTime
metadata when no explicit offset is present.

For new-format records, preserve the capture wall clock and optional explicit
offset. Only an explicit offset (including explicit `Z`) establishes a `date_taken`
instant. Storage year and gallery year/month/day grouping use the capture wall
calendar, not the UTC day of that instant. For example, `2026-01-01 00:15 +08:00`
has a 2025 UTC instant but belongs in capture year 2026 and day 1 January.
Offsetless `2026-01-01 00:15` retains that calendar day and an unknown timezone;
its instant remains unknown. A DST gap/fold in an unspecified timezone is still a
valid camera wall clock; no server-local DST correction or disambiguation occurs.
Explicit `-07:00` and `-08:00` fold timestamps identify different instants.

EXIF precedence is `SubSecDateTimeOriginal`, `DateTimeOriginal`,
`SubSecCreateDate`, then `CreateDate`. Original timestamps use `OffsetTimeOriginal`;
creation timestamps use `OffsetTimeDigitized`, falling back to `OffsetTime`.
An inline offset takes precedence over a separate tag. The first nonempty source
is authoritative: invalid calendar/offset data remains unknown rather than silently
switching to another source. Fractions are truncated to milliseconds; valid offsets
range from -14:00 to +14:00. Leap seconds, timezone names, offset seconds and
incomplete dates are unsupported. No actual media was sampled to validate tag
coverage; tests use synthetic EXIF JSON.

Missing/invalid capture dates display and group as **Capture date unknown**.
`date_imported` remains the real import instant and must never be presented as a
capture date. When there is no capture year, the destination stays `Unknown`.
UTC Date values used inside the calendar formatter are arithmetic carriers only,
not assertions that an offsetless camera was in UTC. Formatting fixes `timeZone`
explicitly and never depends on process/browser defaults.

## Schema and compatibility

The existing `media.date_taken TIMESTAMPTZ` stores an instant. PostgreSQL does not
retain the originally supplied offset or timezone-naive wall clock. One column
cannot faithfully represent both known instants and floating capture calendars.
Existing values cannot reliably be reverse-engineered into their original clock
or timezone. No historical date or file may be rewritten automatically.

Migration `0004_media_capture_dates.sql` implements the approved additive change:

- `capture_local timestamp(3) without time zone NULL`: validated wall-clock fields.
- `capture_offset_minutes smallint NULL`: signed explicit offset; NULL means unknown.
- Keep `date_taken` as the known instant. New offsetless records leave it NULL.
- Require offset/local/instant consistency for new-format records, and bound offsets.
- Leave all existing rows with both new fields NULL; do not backfill or index them.

The migration file is [0004_media_capture_dates.sql](../db/migrations/0004_media_capture_dates.sql). Its schema change is:

```sql
ALTER TABLE public.media
    ADD COLUMN capture_local timestamp(3) without time zone,
    ADD COLUMN capture_offset_minutes smallint,
    ADD CONSTRAINT media_capture_offset_check
        CHECK (capture_offset_minutes BETWEEN -840 AND 840),
    ADD CONSTRAINT media_capture_date_consistency_check CHECK (
        (capture_local IS NULL AND capture_offset_minutes IS NULL)
        OR (capture_local IS NOT NULL AND (
            (capture_offset_minutes IS NULL AND date_taken IS NULL)
            OR (capture_offset_minutes IS NOT NULL AND date_taken IS NOT NULL
                AND date_taken = (capture_local AT TIME ZONE 'UTC')
                    - make_interval(mins => capture_offset_minutes))
        ))
    );
```

The migration must be deployed before this application version: import INSERT/UPDATE
and API SELECT statements now require these columns. Stop writers during rollout; keep
0001–0003 intact and do not run migrations as part of a build or startup. Replacement
metadata updates all three fields in its existing receipt transaction, without
changing recovery/filesystem ordering. SQL must serialize `capture_local` explicitly
as an ISO-like string without a zone (`to_char(..., 'YYYY-MM-DD"T"HH24:MI:SS.MS')`)
to avoid `pg` interpreting a naive timestamp through the server process timezone.
Public media DTOs carry both fields. Capture-based ordering uses wall
clock for new records; legacy UTC/import ordering fallbacks are ordering only,
never inferred capture facts. No new indexes are required here.

## Legacy behavior and deployment

The active EXIF reader uses `captureDateFromExif`. Ordinary inserts and replacement
metadata updates persist local time/offset/instant in the existing transactions;
replacement receipts commit atomically with those fields. All five media read paths
and public DTOs preserve the local timestamp as a zone-free string. New destination
years use the local capture year, not the UTC instant year. Missing captures still
use `Unknown`. Development callers supplying only `dateTaken` remain legacy-format
and use its UTC year; they must supply the new fields to assert a local calendar.

Legacy rows keep both new fields NULL, retaining the explicit legacy UTC display
fallback. Existing files and directories never move. A replacement resolves its
recorded conflict destination rather than recalculating the original target from
the new date policy; it may legitimately retain an old directory year. KEEP_BOTH
and ordinary new imports choose new destinations under the current policy. No
historical date repair, backfill or media scan is performed.

Deployment requirements:

1. Back up PostgreSQL, media and recovery evidence. Stop media writers across the
   schema/application rollout. Review `0004` and run the existing migration CLI
   against the operator-approved target separately; startup/build never migrates.
2. Apply 0004 after 0001–0003, before starting this application version. The nullable
   additions have no backfill/default, but constraint validation scans existing rows
   and ALTER TABLE needs a table lock: use a maintenance window and assess its
   duration on the real installation. No production database was probed here.
3. The migration role needs ALTER permission on media. Normal table-level runtime
   SELECT/INSERT/UPDATE grants cover the new columns; review column-specific grants
   if the deployment uses them. No new extensions, services, environment variables
   or timezone configuration are required.
4. Review external consumers that assumed non-null `date_taken` for every dated
   image: offsetless captures now have a local calendar but no known instant.
   Deploy capture-local-aware consumers with this release. Missing capture grouping
   is separate from import-date ordering.
5. Retain 0004 during application rollback. Older writers do not maintain the new
   field consistency and may fail constraints when updating new-format records;
   do not resume them blindly, drop columns or rewrite dates. Prefer a reviewed
   forward fix with writers stopped.

The migration and actual import/database/API round trips were tested on a dedicated
PostgreSQL 17 cluster with synthetic metadata and paths. Tests verify legacy values
including microseconds, UTC/Singapore/Los Angeles sessions and Node timezones,
midnight/year boundaries, DST folds/gaps, missing dates, calendar sorting, constraint
rejections and replacement receipt rollback. Fixture probes use an epoch-based
server-start identity so changing session timezones cannot disguise or falsely
reject the server. Every fixture/database write verifies its isolated target;
rollback in a failed transaction uses the already verified non-rebindable client.
No migration was applied to `mygallery` and no actual media was read or modified.

The opt-in suite is `scripts/media-capture-postgres.test.ts` with an explicitly
provisioned `CAPTURE_PG_FIXTURE`. It refuses reused databases and arbitrary servers.
A fixture contains `root`, `directory`, `socket`, `port`, `role` and `database`:
root is a private owned `/tmp/gallery-capture-pg-*` directory, directory is root/data,
socket is root/socket, port is 55443, role is capture_test, and database is
 gallery_capture_dates_test. Provision PostgreSQL 17 with TCP disabled, that role,
and the private socket; supply fixture.json via CAPTURE_PG_FIXTURE. The suite verifies
its maintenance connection before creating the named database, then applies SQL
0001–0004 transactionally inside that disposable database only. It never resets or
deletes an existing database. Run with `node --import tsx --test
scripts/media-capture-postgres.test.ts`; otherwise it explicitly skips. Keep other
PostgreSQL suites disabled unless their independent fixtures include 0004 too.

Limitations remain: historical offsets cannot be recovered automatically, invalid
EXIF dates become unknown, fractions beyond milliseconds are truncated, and an
explicit offset is not an IANA timezone identifier. DST rules are never inferred
from location. Synthetic tests do not prove every camera/video metadata convention
or hardware behavior; verify representative non-user fixtures before enabling a
new metadata format. Storage locks, mount checks and recovery protocols are unchanged.

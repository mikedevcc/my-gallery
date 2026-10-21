# My Gallery SQL migrations

Versioned plain SQL is the migration source of truth going forward. Historical
files in `prisma/migrations/`, the old Prisma model, and generated client remain
unchanged for reference; do not use Prisma migrate/db push to provision or update
the gallery database.

## Layout and versioning

```text
db/migrations/
  README.md
  0001_initial_schema.sql
  # Future example: 0002_describe_the_change.sql
```

Use consecutive, zero-padded versions and descriptive snake_case names. Apply
versions in numeric order, once per database. Never edit or renumber an applied
migration; correct it with a new version. Review each future migration separately,
including data conversion, locking, backup/recovery, and transaction requirements.
Do not add optimizations or schema improvements to version 0001.

## Runner and commands

The runner uses Node.js, TypeScript (`tsx`), and `pg`; no new packages are needed.
The deployment environment must install `tsx` (currently a devDependency), or run
from a release environment with development tools installed. PostgreSQL 17 and a
compatible `pg_dump` executable are required for baseline verification/adoption.
Do not use the old direct-psql initialization procedure with this runner: it does
not record history. A database initialized that way must use explicit adoption.

```bash
npm run db:migrate -- --help
npm run db:migrate:test  # offline tests; no PostgreSQL connection
```

Every connecting command requires `GALLERY_MIGRATION_URL` plus separate `--host`,
`--port`, and `--database` options matching that URL. The URL must contain an
explicit host, port, user, and database; only the optional `sslmode` query option
is supported. Neither `.env` nor `DATABASE_URL` is loaded. Maintenance databases
are forbidden; simple lowercase database names are required. TCP connections only
(the actual server port is verified). Set credentials through the deployment
secret environment, never through committed files or command-line arguments.
Use TLS with certificate verification for remote production connections.

Examples below are documentation, not authorization to run database operations.
Replace the example target only after independently verifying host/port/database:

```bash
# Set GALLERY_MIGRATION_URL securely, e.g. for gallery_stage on 127.0.0.1:5432.
npm run db:migrate -- status --host 127.0.0.1 --port 5432 --database gallery_stage
npm run db:migrate -- plan --host 127.0.0.1 --port 5432 --database gallery_stage
```

`status` and `plan` return target, applied history, pending filenames/checksums,
SQL-policy executability, and whether initialization/adoption is needed. Both
use read-only repeatable-read transactions, create no tables, and fail on history
drift. A plan is advisory: a concurrent deployment may change it before execution.
Neither command proves that the live application schema has no manual drift.

Writes additionally require `--confirm` with the exact database name. The runner
checks current_database(), server port, and PostgreSQL major version before any
write. Host confirmation compares the explicitly supplied hostname to the URL;
it is not cryptographic cluster identification. Operators must verify DNS,
credentials, TLS identity, and the intended server independently.

`public.schema_migrations` records integer version, filename, raw-file SHA-256
checksum, and applied_at (timestamptz). History must be an exact contiguous prefix
of local migrations. Missing/duplicate versions, renamed/modified applied files,
unknown applied versions, malformed ledgers, and gaps stop execution. Checksum
changes include whitespace/newlines: preserve applied files byte-for-byte.

Writes use a transaction-scoped advisory lock shared by all runner commands.
One transaction covers the whole pending batch plus ledger writes. Any migration
failure rolls back the batch; the lock releases automatically on transaction end
or disconnect. A competing runner fails immediately. SQL errors identify the file
and PostgreSQL error code without printing credentials or SQL values. Lock timeout
is 5 seconds and statement timeout is 60 seconds. Long migrations need explicit
review and a deliberate code/configuration change, not an implicit timeout bypass.
Manual SQL/DDL does not honor the advisory lock: enforce a deployment maintenance
window, especially for adoption, and stop other writers/schema changes.

### SQL policy

The default is fail-closed, with no force/destructive override. Only declarative
CREATE TABLE, CREATE [UNIQUE] INDEX, ALTER TABLE ADD COLUMN/CONSTRAINT, and ADD
GENERATED ALWAYS AS IDENTITY are supported. Table targets must be qualified as
`public.name`. Every statement needs a semicolon. No psql meta-commands,
dollar-quoted bodies, escape strings, explicit transactions, ledger edits,
IF NOT EXISTS, procedural SQL, DML, destructive operations, or nontransactional
operations (including CONCURRENTLY) are admitted. Unsupported future changes
require separate design/review rather than weakening protections during deployment.

This conservative lexer/allowlist is a guardrail, not a complete PostgreSQL parser
or a sandbox for hostile SQL. Migration files are trusted, reviewed source code;
expressions, referenced functions, existing triggers and data conversions need
human review. PostgreSQL supplies final syntax/transaction enforcement. Do not run
unreviewed migrations with a superuser. There are no down migrations, resets,
database creation, or automatic schema adoption commands.

## Baseline scope

`0001_initial_schema.sql` is the permanent, validated and adopted application
baseline. The original PostgreSQL 17.7 export (produced with pg_dump 18.6) is
archived separately and is not required by the application, runner, or tests.
The baseline preserves:

- Eight tables in `public`: album, city, country, image, media, media_album,
  trip, and video.
- Five `GENERATED ALWAYS AS IDENTITY` columns, including sequence names/options.
- All column types, precision, nullability, defaults, and 14 CHECK constraints.
- Eight primary keys and three additional UNIQUE constraints, creating eleven
  backing indexes. The snapshot has no standalone application indexes.
- Eight foreign keys with the snapshot's original deletion rules.

Keep the baseline byte-for-byte unchanged, including its historical source
comments: its checksum is recorded in migration history and pinned by an offline
integrity test. Future schema changes must use new versioned SQL migrations.

Prisma's `_prisma_migrations` table and key are intentionally excluded. Dump
headers, psql restriction commands, and session settings are omitted. Application
DDL is otherwise retained verbatim, in source order. No IF NOT EXISTS guards are
used: an unexpected existing object must fail rather than conceal schema drift.

The baseline contains no application data, sequence current values, roles,
ownership assignments, grants, database creation, extensions, or media files.
It assumes an existing `public` schema, standard PostgreSQL heap storage and
default tablespace, and a role authorized to create objects there. These are
deployment prerequisites, not schema changes. No PostGIS extension is referenced
by this application snapshot; provision geocoding infrastructure separately.

Deletion semantics remain unchanged: deleting a Trip clears media.trip_id;
deleting an Album removes memberships; deleting media removes subtype metadata
and memberships and clears Album covers. Collection deletion preserves media.

## Fresh database initialization

After separate execution approval:

1. Provision an empty PostgreSQL 17 database and approved roles separately. Check
   the target identity, `public` schema, permissions, encoding, locale, and storage
   defaults. The runner does not create a database or grant permissions.
2. Back up any existing assets and review the plan. `init` rejects an existing
   ledger or any user relations, routines, enums/domains/ranges; it must never be
   used to adopt an existing library.
3. Run, using the separately confirmed example target:

   ```bash
   npm run db:migrate -- init --host 127.0.0.1 --port 5432 --database gallery_stage --confirm gallery_stage
   ```

   This creates the ledger and executes all pending migrations, including 0001,
   atomically. If anything fails, neither schema nor history is committed.
4. Check status, compare the provisioned schema, and run disposable-data smoke
   tests before enabling the app. Subsequent releases use `plan` followed by:

   ```bash
   npm run db:migrate -- up --host 127.0.0.1 --port 5432 --database gallery_stage --confirm gallery_stage
   ```

`up` refuses absent or empty history. An existing schema is never inferred to be
baselined. The baseline does not restore library data or sequence current values.

## Existing database baseline adoption

Adoption records only 0001; it never executes its application DDL. It requires a
maintenance window with all other schema changes stopped, an absent new ledger,
a complete public-schema match, and explicit independent reviewer approval.
Historical `_prisma_migrations` is ignored for comparison and left untouched.
Unexpected user schemas outside public stop automatic verification/adoption.

1. Obtain execution approval, back up schema/data and media, and independently
   verify the target server. Inspect old migration records and manual schema
   changes. Do not drop/reset anything or execute 0001 against existing tables.
2. Generate a read-only verification report (store it outside version control):

   ```bash
   npm run db:migrate -- verify-baseline --host 127.0.0.1 --port 5432 --database gallery_stage
   ```

   Save the JSON object from stdout to an operator-controlled file. npm can add
   a command banner; for clean JSON redirection use `npm run --silent db:migrate
   -- verify-baseline ... > /secure/deployment/baseline-review.json`.
   pg_dump runs in read-only mode. The runner compares its full public DDL with
   0001, excluding dump settings, public-schema boilerplate, ownership/grants,
   and the two migration bookkeeping tables. Column/constraint/identity definitions
   remain significant. This is conservative text canonicalization, not a general
   semantic diff: equivalent spelling from a different pg_dump can fail closed.
3. A separate reviewer must independently inspect a current schema export/catalog
   and comparison results, including defaults, nullability, identities, indexes,
   FK deletion rules, and unexpected objects. They attest by setting `reviewedBy`
   to their identity and `reviewDecision` to `approved` in the report. Preserve
   verifiedAt, host, port, database, baselineChecksum and schemaChecksum unchanged.
   This is a human attestation, not a signature system; organizational separation
   of duties and protected report storage remain operator responsibilities.
4. After reviewing the report and target again:

   ```bash
   npm run db:migrate -- adopt-baseline --host 127.0.0.1 --port 5432 --database gallery_stage --confirm gallery_stage --verified-report /secure/deployment/baseline-review.json
   ```

   The runner obtains its lock, repeats read-only schema verification, checks all
   report target/checksum fields and reviewer approval, then creates the ledger
   and records only version 1 in a transaction. Future versions require a separate
   `up` command. Retain the report with deployment records because the minimal
   ledger does not store adoption mode/reviewer details.
5. Any mismatch stops adoption. Investigate rather than editing an applied
   migration, forging a report, or manually inserting a ledger row. A ledger
   already present is also rejected, even if empty; reconcile it explicitly.

## Deployment, backup and recovery

- Before writes, take a recoverable database backup (schema and data), preserve
  matching media backups and configuration, and verify the restore procedure.
  Store release Git revision, plan, checksums, reviewer approvals, and execution
  logs with deployment records. Backups are an operator prerequisite, not something
  the runner can prove from a flag.
- Use a dedicated deployment role with the DDL/ownership privileges it needs;
  keep the application's runtime role separate and deny it ledger modification.
  Revoke unwanted public schema creation privileges as deployment policy; this
  runner does not change grants. Do not run migrations on application startup.
- Run one deployment at a time and stop manual DDL. An advisory lock coordinates
  this runner only. Read-only checks and pg_dump use separate snapshots, so adoption
  also relies on the maintenance window to prevent concurrent schema changes.
- On SQL failure, fix a never-applied migration and retry only after inspection.
  Never change a successfully applied migration; add a new version instead.
- If commit acknowledgement or connectivity fails, do not assume rollback. Restore
  connectivity and run status/plan to reconcile history and schema before retrying.
  Do not delete or repair ledger entries blindly. A closed connection releases the
  transaction lock; do not kill other database sessions without authorization.
- For history/checksum drift, restore the exact deployed files and investigate
  unauthorized changes. For schema drift, compare a fresh export and design an
  explicitly reviewed corrective migration. Do not auto-baseline away drift.
- Recovery from a committed unwanted change requires a reviewed forward migration
  or an approved backup restore coordinated with media state. No automatic rollback
  or reset is offered.

## Verification status

The initial baseline was previously applied to an isolated PostgreSQL 17.7 test
instance and its exported application DDL matched the reference. That temporary
instance was subsequently stopped and retained. The new runner has only received
offline unit, type and lint checks; its database paths (lock contention, rollback,
initialization, adoption, and history enforcement) still require separately
approved disposable-database integration tests. Do not infer runner execution
validation from the earlier direct-psql baseline test. No database connection or
database operation is authorized by creating this documentation.

## Replacement receipts (0002)

`0002_replacement_receipts.sql` adds `public.media_replacement_receipts`: operation
UUID primary key, media ID, target path, original/incoming SHA-256 hashes and
commit timestamp. There is intentionally no foreign key or cascading deletion;
receipts must survive media deletion. Existing application tables and 0001 are
unchanged. Grant the runtime role SELECT/INSERT on this table separately, following
your deployment role policy. Review and apply this forward migration before
replacement traffic; creating this file does not apply it. No database was used
for H4-B validation: SQL discovery/safety checks and mocked transaction tests are
offline only. See [the recovery protocol](../../docs/replacement-recovery.md)
for durability assumptions, backups and remaining H4-C work.

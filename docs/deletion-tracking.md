# Durable deletion tracking and explicit recovery (M1-A / M1-B)

Deletion uses the existing canonical destination lock and mounted-storage checks.
Before database mutation it hashes the original and thumbnail, binds an operation
UUID to the lock, synchronizes file/parent/lock evidence, and writes
`.deletion-operations/<uuid>.json`. The shared journal writer uses an exclusive
0600 temporary file, file fsync, atomic rename and parent-directory fsync. The
journal binds installation/filesystem identity, media ID, canonical target,
original identity, thumbnail identity, lock directory and ownership token. An
explicit null identity means a file was absent on validated storage.

States: PREPARED -> COMMIT_PENDING -> COMMITTED -> COMPLETE. Transaction errors
record COMMIT_UNKNOWN, including errors followed by acknowledged ROLLBACK. Only
independent recovery decides the outcome. A failed initial journal write can
leave incomplete evidence requiring manual investigation.

Metadata DELETE and the receipt INSERT share one PostgreSQL transaction, operation
advisory lock and synchronous_commit setting. Expected ID/path and storage/file
identity are checked before commit. Receipts survive media deletion and are not
automatically garbage collected. Migration 0003 must already be applied; M1-B
requires no new migration or changes to applied migrations.

## Manual maintenance command

Stop the writer application before recovery and use the same Unix user and Linux
PID namespace as the failed worker. Preserve journals, owner records and receipts;
take coordinated database/media backups. Confirm the expected HDD is mounted,
the installation ID/filesystem UUID are correct, and the URL identifies the
original primary database with intact history. Do not use a replica or a database
restored independently from its corresponding media state.

Set `MEDIA_STORAGE_ROOT`, `MEDIA_STORAGE_UUID`, `MEDIA_STORAGE_ID` and
`MEDIA_RECOVERY_DATABASE_URL` explicitly through the deployment environment. The
CLI never loads `.env`; keep database credentials out of shell history. Then use
this example with the independently verified host, port and database substituted:

```sh
node --import tsx scripts/recover-media.ts OPERATION_UUID \
  --kind deletion --host HOST --port PORT --database DATABASE_NAME \
  --confirm-installation "$MEDIA_STORAGE_ID"
```

Find the UUID in the retained deletion journal; inspect without editing it. The
command verifies the URL against all target flags, actual database/role/port and
PostgreSQL 17 before loading the application pool. The maintenance database role
needs SELECT on public.media and public.media_deletion_receipts, schema USAGE and
permission to execute the PostgreSQL advisory-lock functions. Recovery performs
only read-only database transactions; filesystem cleanup and journal updates are
writes. There is no startup hook or force/age-based bypass. Existing replacement
commands remain unchanged (default kind is replacement; `--kind replacement` is
also accepted).

## Outcome rules

Recovery verifies the primary is not in recovery, obtains the same nonblocking
operation transaction advisory lock as deletion, then reads fresh READ COMMITTED
receipt and metadata snapshots. An absent receipt before this gate is never proof
of rollback. It also proves the old filesystem owner stopped using boot ID,
PID/start time and UID, and verifies the journal token and canonical lock key.
The advisory lock remains held throughout filesystem reconciliation.

- Matching receipt, with neither the media ID nor target path still referenced:
  verify all surviving files first; remove only recorded identity matches, fsync
  parents, write COMPLETE durably and release the destination lock. Interrupted
  unlinks are safe to repeat when the recorded file is already absent.
- No receipt after that gate, original metadata intact, and original identity
  unchanged: preserve original, thumbnail and metadata; write ABORTED durably and
  release the lock. No precommit filesystem changes need reversal.
- Busy transaction/live owner, unavailable database/HDD, standby, reused path,
  changed inode/content, symlink, missing original on rollback, contradictory
  journal/receipt/metadata or unverifiable ownership: stop and retain evidence and
  the destination lock for investigation.

Recovery itself may be restarted. A terminal journal with no remaining lock
returns ALREADY_COMPLETE without touching a newly reused path. A lock owned by a
different operation is never taken over or removed. Same-process recovery calls
are excluded in addition to the cross-process database and filesystem gates.

## Limitations and manual investigation

M1-A journals without a thumbnail identity can be recovered automatically only
when the thumbnail is absent (or when aborting without deleting files). Existing
unrecorded thumbnails are preserved and require operator investigation. Never
invent an identity or edit approval/evidence records to bypass this check.

A crash before journal persistence, ownerless locks, or termination between owner
unlink and lock-directory removal requires manual investigation; do not remove a
lock based on age. No metadata reconstruction, automatic recovery, reset, receipt
GC or physical file restoration after a committed deletion is provided. Recovery
honors committed deletion intent, so removed original bytes require backups to
restore. N1 conflict-marker reconciliation remains separate replacement work.

Requires local Linux ext4/XFS and working file/directory fsync, PostgreSQL durable
WAL settings, hardware flushes and cooperating destination-locked writers.
Concurrent manual SQL/filesystem writers and physical unplugging between checks
and syscalls are outside these guarantees. Receipt absence cannot resolve lost
primary history after an independent backup restore/failover.

## Verification

Offline tests use temporary media, mocked storage mounts and mocked databases:

```sh
node --import tsx --test scripts/deletion-tracking.test.ts \
  scripts/deletion-recovery.test.ts scripts/media-database.test.ts \
  scripts/recover-media.test.ts
```

Crash tests SIGKILL workers during preparation, precommit, lost acknowledgment,
committed state, original/thumbnail cleanup and completion, and terminate recovery
itself during cleanup, abortion and completion. These are process crashes, not
physical power-loss tests.

`deletion-postgres.test.ts` is opt-in and requires a fresh disposable PostgreSQL
17 database named `m1b_deletion_test_*` on 127.0.0.1:55441 with its verified data
directory under `/tmp/gallery-m1b-pg-*/data`. Set M1B_INTEGRATION_URL and
M1B_INTEGRATION_DATA_DIRECTORY explicitly. It verifies identity before each write,
creates minimal test tables directly, and never executes application migrations.
It tests real receipt atomicity, rollback after receipt insertion, lost commit
acknowledgment and an actual uncommitted deletion holding the advisory lock.

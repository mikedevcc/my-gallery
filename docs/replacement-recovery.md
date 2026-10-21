# Replacement recovery tracking (H4-B)

This release records evidence for H4-C; it does **not** automatically recover an
interrupted operation, restore backups, retry metadata, or clear retained locks.
Only replacement operations have journals/receipts. Import and deletion still
have the conservative destination-lock behavior described in
[destination locking](destination-locking.md).

## Deployment prerequisite

Review and apply `0002_replacement_receipts.sql` through the normal versioned SQL
runner in a separately authorized deployment window, after coordinated database
and media backups. It has not been executed as part of this change. Deploy the
migration before enabling replacement traffic; remove older writer processes.
The runtime role needs SELECT and INSERT on `public.media_replacement_receipts`
in addition to its existing metadata privileges. Do not grant receipt UPDATE or
DELETE to the runtime role. Receipts deliberately have no foreign key: they remain
usable evidence after a media row is deleted. There is no automatic retention/GC.

## Durable evidence and states

A replacement holds the existing canonical destination lock throughout. Metadata
and target existence are revalidated. Before the original is moved, it records
`<MEDIA_STORAGE_ROOT>/.replacement-operations/<operation UUID>.json` containing:
installation ID, filesystem UUID, media ID, canonical target, incoming staging
path, unique backup path, lock directory, original/incoming SHA-256 hashes,
byte sizes, device/inode identities, and recovery state. Hashing streams files and
checks that their identities remain stable during the read.

Journal updates write an exclusive mode-0600 temporary file, fsync that file,
atomically rename it over the JSON, then fsync the journal directory. Initial
preparation syncs both media files, their parent chains, and the lock owner and
lock directories. Directory creation is allowed only after live storage validation;
the configured storage root and installation marker are never created here.
All mutation steps retain storage/ownership validation. An fsync error fails closed.

| State | Meaning / interruption window |
| --- | --- |
| PREPARED | Durable intent exists before the first rename. Publication might be untouched, partially completed, or complete. |
| FILES_PUBLISHED | Incoming target and original backup names have been synced in the destination directory. Metadata has not yet been attempted. |
| COMMIT_PENDING | Durable intent to update metadata. The transaction may not have started, may still be in flight, or may have committed. |
| COMMIT_UNKNOWN | Metadata callback failed, including a possible lost COMMIT response. No filesystem rollback or cleanup is attempted. |
| COMMITTED | Metadata/receipt transaction acknowledged commit. Backup and staging cleanup may be incomplete. |
| COMPLETE | Cleanup directories and final journal have been synced. Lock release or outer staging-job cleanup may still be interrupted. |

Before publication, a read checks the receipt store and operation ID. An absent
migration, failed query, or unexpected existing receipt stops publication and
retains the prepared journal/lock for review. Receipt-store availability is not a
substitute for the later transaction succeeding.

Metadata updates and receipt INSERT use the **same PostgreSQL client and
transaction**. A missing media row aborts the transaction. The receipt binds the
operation UUID to media ID, destination and original/incoming hashes; its primary
key prevents reuse. `SET LOCAL synchronous_commit = on` requires a local durable
commit acknowledgement, subject to PostgreSQL's fsync/storage configuration. The
storage/lock guard runs again immediately before COMMIT. Any error attempts
ROLLBACK and releases the client; a failed COMMIT response never proves rollback.

A successful receipt is authoritative evidence of metadata commit even if the
journal still says COMMIT_PENDING or COMMIT_UNKNOWN. The application preserves
both file generations, staging and ownership after a metadata error; it no longer
blindly restores the old bytes on a potentially committed transaction.

## Read-only reconciliation, ready for H4-C

`scripts/replacement-recovery.ts` exposes `readReplacementJournal` and
`inspectReplacementRecovery(root, operationId, lookupReceipt, databaseSettled?)`.
These are internal helpers, not an automatic startup task or a recovery CLI.
Use the primary database receipt reader `getReplacementReceipt`; query failures
propagate. Inspection validates storage and journal identity, compares receipt
fields, and hashes each surviving target/backup/staged file. It returns database
COMMITTED, UNKNOWN, NOT_COMMITTED or INCONSISTENT plus observed file dispositions.
Repeated inspection writes nothing and is idempotent while the evidence is stable.
A conflicting receipt is INCONSISTENT; unrecognized bytes are OTHER and require
manual investigation. Identical original/incoming bytes are classified INCOMING;
recorded inode identities remain available for forensic review.

Before reliable recovery review, stop **all** writers and independently establish
that the original database transaction has finished (including disconnected or
partitioned sessions). An absent receipt is UNKNOWN by default. Only then may a
caller explicitly pass `databaseSettled=true` to interpret absence as
NOT_COMMITTED. That parameter is an external attestation, not proof provided by
the helper. A journal state alone never substitutes for this check. Never query a
lagging replica, treat a timeout as absence, or use lock age/PID absence as proof.
Inspect against the same primary/history as the operation: a database restore or
failover that lost acknowledged transactions invalidates this inference.

Preserve journals, temporary journal files, owner records, backups, staging and
receipts together. Do not rerun an unresolved replacement, delete its conflict,
manually clear locks, prune evidence, or replay its metadata until the outcome is
reviewed. H4-C must validate lock ownership and actual bytes again before any
repair, make repair steps restartable, and establish a safe lock-release policy.
No repair/delete command is added by H4-B.

## Limitations

The existing rename-original / hard-link-incoming publication sequence remains.
Readers can see a missing target or a transient metadata/bytes mismatch. Power loss
can leave any partially completed sequence described above. Filesystem and
PostgreSQL do not form one atomic transaction. H4-B preserves evidence and avoids
blind rollback but does not restore availability or consistency automatically.
Deletion/import crash recovery, thumbnail cache races and binding previewed
conflicts to an exact generation remain outside this change.

The supported local Linux ext4/XFS mount must provide correct atomic rename,
hard-link and directory fsync semantics. All paths must remain on the validated
HDD. No NFS/SMB, hostile/nonparticipating filesystem writers, lying disk write
caches or broken storage hardware are covered. Mount checks cannot eliminate a
physical disconnect between a check and a syscall. PostgreSQL fsync/full-page
writes and durable disk flush behavior must be correctly configured. Backup and
restore must preserve corresponding database receipts and filesystem evidence.
Completed journals are historical snapshots: later operations can legitimately
change their target bytes. They do not authorize restoring an older generation;
H4-C must distinguish the current unresolved owner from completed operations.
Journals/receipts are retained indefinitely and contain paths; restrict access and
plan a separately reviewed retention policy.

## Offline checks

```sh
node --import tsx scripts/replacement-recovery.test.ts
node --import tsx scripts/media-database.test.ts
node --import tsx scripts/destination-lock.test.ts
node --import tsx scripts/storage-safety.test.ts
node --import tsx scripts/migrations/core.test.ts
```

Fixtures use temporary files, mocked mount probes and mocked PostgreSQL clients.
They exercise interrupted sequences and injected persistence failures; they are
not real PostgreSQL integration, physical power-loss, or HDD durability tests.

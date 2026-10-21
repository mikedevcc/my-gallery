# Atomic replacement and crash recovery (H4-C)

Replacement uses the existing destination lock, validated local HDD and migration
0002 receipts. Neither historical migration changes. Deploy 0002 **before** this
code and stop/drain all older writers before upgrading. This protocol assumes all
writers share the same local filesystem **and Linux PID namespace**, including
visible `/proc` process start times and boot ID. Run writers and recovery as the
same Unix service account; cross-user recovery is refused because `hidepid`
permissions can otherwise make a live process appear absent. It supports the documented single
Debian installation, not independently deployed hosts sharing network storage.

## Publication and transaction ordering

1. Hold the canonical destination lock; revalidate metadata, storage and file
   identities. Staging must have a different inode from the original.
2. Bind the owner record to an operation UUID. Persist the protocol-2 journal
   containing the lock token, target, backup, staging/publication paths, original
   and incoming SHA-256/size/device/inode identities and installation/filesystem
   IDs. Sync media files, directory parent chains, owner record and journal.
3. Create an exclusive **hard link** from the original target to its unique backup
   and fsync the destination directory. The target remains readable throughout.
4. Link staging to the unique publication path, sync its directory, verify both
   identities again, and atomically rename publication over the target on the
   same filesystem. Sync the destination directory before attempting metadata.
5. Persist FILES_PUBLISHED then COMMIT_PENDING. Metadata and receipt INSERT use
   one PostgreSQL transaction with `synchronous_commit=on`. The transaction first
   acquires `pg_try_advisory_xact_lock(hashtextextended(operationId, 48291))`.
   No replacement metadata write may precede that lock. A storage/owner guard
   runs again before COMMIT.
6. After confirmed commit, verify the incoming target and all remaining evidence,
   invalidate its thumbnail, remove only matching staging/publication/backup
   files, syncing each affected directory, and persist COMPLETE before releasing
   destination ownership. Thumbnail generation now acquires the destination lock
   too, so a previous generator cannot republish stale cache after invalidation.

The original backup remains intact until commit is confirmed. Neither publication
nor rollback unlinks the destination before replacing it. PostgreSQL and the
filesystem still do not share an atomic transaction: readers can see new bytes
before metadata commits. Existing readers with open descriptors can finish
reading the old inode. HTTP clients may retain previously returned thumbnails.

## States and interrupted operations

| State | Meaning |
| --- | --- |
| PREPARED | Durable intent precedes backup/publication; either step may be partial. |
| FILES_PUBLISHED | Incoming target directory is synced; metadata not yet attempted. |
| COMMIT_PENDING | Database work may not have started, may be running, or may have committed. |
| COMMIT_UNKNOWN | Metadata callback failed, including possible lost acknowledgement. |
| COMMITTED | Transaction acknowledged commit; cleanup may be incomplete. |
| COMPLETE | Committed cleanup and journal are durable; lock release may still be interrupted. |
| ROLLED_BACK | Original restored and synced, safe auxiliary cleanup complete; incoming staging retained for explicit retry. |

The normal request path tries guarded reconciliation after a failure. A fresh
READ COMMITTED, read-only database transaction acquires the **same operation lock**
nonblockingly, then queries the receipt and current media path. Thus absence can
be used only after any original metadata transaction has finished. A busy lock,
query error, missing metadata or mismatched receipt leaves the operation locked.
A lost acknowledgement with a matching receipt completes cleanup and returns
success. A definitely uncommitted operation restores the original, then reports
the original failure to the caller.

Reconciliation validates every surviving file using both hashes and inode/device
identity before its first mutation. For rollback it verifies the original backup
and expected target, then atomically renames the backup over the target. If a
previous recovery already restored it, the matching original target suffices.
For committed operations the incoming target must already match; recovery never
publishes unexpected bytes or repeats metadata SQL. Unknown or missing required
bytes remain locked for investigation. Staging is retained after rollback.

## Recovery after a process restart

Recovery is an explicit maintenance command, **not** an automatic startup hook.
Stop/drain gallery writers before maintenance. Preserve database/media backups and
all journal, owner, staging and backup evidence. Restore the expected mounted HDD
and installation marker first. Set configuration explicitly; this command never
loads `.env` or uses a default database.

```sh
# Set MEDIA_STORAGE_ROOT, MEDIA_STORAGE_UUID, MEDIA_STORAGE_ID and a protected
# MEDIA_RECOVERY_DATABASE_URL for the SAME primary database as the operation.
node --import tsx scripts/recover-media.ts OPERATION_UUID \
  --host localhost --port 5432 --database mygallery \
  --confirm-installation "$MEDIA_STORAGE_ID"
```

The example is an operator command, not authorization to run it during review.
It verifies the configured database, role, port and PostgreSQL 17 before recovery.
The database role needs SELECT on media/receipts and permission to use advisory
locks; the recovery transaction makes no persistent database changes.

Recovery holds the PostgreSQL operation lock while claiming the **existing**
filesystem lock. It checks that the journal's canonical key, operation UUID and
owner token agree, then proves the prior filesystem worker stopped using boot ID,
PID and process start time. A live worker is never evicted; neither lock age nor
PID absence by itself establishes commit outcome. Database locking separately
protects against a transaction still finishing after its Node worker died.
The recovery owner record is durably updated so recovery can itself restart.
Concurrent recovery attempts are excluded by the PostgreSQL operation lock.

Repeated recovery returns ALREADY_COMPLETE after a terminal journal's lock is
released, without touching a later generation. If another operation now owns the
same destination, the old journal cannot claim or release its lock. Completed
journals are historical evidence, not permission to restore an older original.

The read-only H4-B `inspectReplacementRecovery` helper remains available for
investigation. Its `databaseSettled` argument is only external attestation; use the
H4-C guarded recovery command for mutations rather than treating that flag as proof.

## Manual investigation cases

Recovery deliberately stops for a live/unverifiable owner, busy database lock,
wrong storage device, conflicting receipt, lost database history, changed media
path, unknown file identity, missing original backup, or committed receipt with
no matching incoming target. Keep writers stopped and retain all evidence; inspect
against the primary, resolve the discrepancy explicitly, and then retry. Do not
remove a lock, replay metadata, or delete staging based on age or a timeout.

H4-B journals without protocol-2 publication/owner information and legacy owner
records without process identity require manual investigation; they are not
silently upgraded. Ownerless/nonterminal lock directories also require manual
review. A crash during initial lock creation or final owner unlink/rmdir can leave
such a directory; automatic deletion could race a new owner. There is no force,
reset, age-based takeover, or manual-repair bypass in the CLI. If an unresolved
request's owner process is still alive, stop it before maintenance recovery.

Do not infer absence after restoring a database backup or failing over to a server
that lost acknowledged transactions. Confirm the corresponding primary history
and coordinated filesystem backup before deciding an outcome.

## Durability boundaries and verification

Requires local Linux ext4/XFS with correct hard-link, atomic rename and directory
fsync behavior, PostgreSQL durable WAL/fsync configuration and working hardware
flushes. Physical disconnects between validation and syscalls, broken hardware,
nonparticipating writers and manual SQL are outside the protocol. Journals and
receipts are retained indefinitely; access/retention policies need separate review.
Import crash recovery is not added by H4-C. Deletion recovery is documented in
[deletion tracking](deletion-tracking.md). Destination locking excludes competing
operations while replacement or deletion recovery is unresolved.

Offline checks use temporary media and mocked mount/SQL probes:

```sh
node --import tsx scripts/replacement-files.test.ts
node --import tsx scripts/replacement-recovery.test.ts
node --import tsx scripts/media-database.test.ts
node --import tsx scripts/destination-lock.test.ts
node --import tsx scripts/storage-safety.test.ts
```

The crash suite kills worker processes at preparation, backup, publication,
pre-commit, lost acknowledgement, committed journal, cleanup and completion, plus
kills recovery after restoration. A separate opt-in
`replacement-postgres.test.ts` refuses all but the positively identified disposable
cluster/database; normal invocation skips it. It verifies real SQL rollback,
transactional receipts, acknowledgement reconciliation and in-flight advisory
locking. These tests are not physical power-cut or production-volume tests.

## Staged conflict marker reconciliation (N1)

New conflict resolutions create `.incoming/<conflictId>/.resolution-lock` with
an immutable, atomically published and fsynced `owner.json` (0600). It records an
operation UUID, random ownership token, action, installation/filesystem identity,
PID/UID/boot/start-time identity, recorded target and staged path, file identities
and job/marker directory identities. An exclusive mkdir excludes other requests
and Node processes. No marker is removed or stolen because it is old.

Before replacement publication, the destination journal binds the operation UUID,
conflict ID, marker token, owner-file identity, metadata-file identity and directory
identities. The recorded conflict target and existing media ID, when present, must
match the replacement. The existing PostgreSQL replacement receipt remains the
commit authority; N1 adds no schema or migration.

Replacement recovery now validates surviving conflict evidence before changing
media files, then retains the destination lock until conflict cleanup is durable:

- Confirmed commit: retain only the committed incoming destination, clean matching
  replacement evidence, remove verified conflict metadata and marker, and remove
  the job directory only when empty. A missing staged file is supported; recovery
  uses the journal directly and does not call findStagedConflictFile.
- Definitely rolled back: restore the original through H4's guarded rollback,
  preserve incoming staging and conflict metadata, and remove only the matching
  marker so the user can retry. Missing staging on rollback requires investigation.
- Ambiguous receipt/transaction, live owner, changed file/directory/token, symlink,
  unknown directory entry or unavailable storage: retain all surviving evidence
  and locks. An error no longer triggers an unconditional wrapper marker removal.

The journal's optional conflict phase advances through BOUND, CLEANUP_PENDING,
MARKER_REMOVAL_PENDING and FINALIZED, with the confirmed outcome recorded before
artifact removal. Only durable MARKER_REMOVAL_PENDING (or FINALIZED) permits a
retry to accept an already-missing owner file/marker. Directory identities and
empty-directory checks remain mandatory. Media state COMPLETE or ROLLED_BACK
alone does not release ownership while conflict cleanup remains unfinished.
Repeated recovery can finish interrupted metadata unlink, owner unlink, marker
rmdir or job rmdir. A terminal operation with no retained destination lock is a
no-op; it never removes a later resolver's marker.

### Maintenance procedure

Stop/drain application writers, use the same Unix account/PID namespace, verify
the original primary database and expected HDD, and preserve coordinated backups.
Set MEDIA_RECOVERY_DATABASE_URL and the three MEDIA_STORAGE_* settings explicitly
(the maintenance CLI never loads .env). Use the operation UUID from owner.json or
the destination journal, then run the existing command with verified target flags:

```sh
node --import tsx scripts/recover-media.ts OPERATION_UUID \
  --kind replacement --host HOST --port PORT --database DATABASE_NAME \
  --confirm-installation "$MEDIA_STORAGE_ID"
```

After COMMITTED, verified job artifacts are gone. After ROLLED_BACK, staging and
metadata remain and the conflict can be retried. ALREADY_COMPLETE changes nothing.
There is no startup recovery or force option. Database permissions are unchanged:
SELECT on replacement receipts/media and access to the operation advisory lock;
filesystem maintenance needs the service account's existing storage permissions.

Legacy ownerless markers, old journals without conflict bindings and markers left
before journal handoff remain blocked for manual investigation. Never fabricate
ownership/receipt evidence or clear markers by age. Stop writers and compare the
original, staging, metadata, backup, journal and primary receipt history before an
operator-approved repair. A partial initial owner write, unknown artifact, or
ownerless destination lock still cannot be safely repaired by this command.

SKIP and KEEP_BOTH now use owned markers and verified nonrecursive cleanup too.
They have no replacement receipt/journal and do not gain crash recovery here;
after uncertain side effects their retained markers require manual investigation.
Ordinary imports and deletion recovery keep their existing protocols. No changes
to applied migrations 0001–0003 are needed.

N1 tests use temporary filesystem fixtures and mocked PostgreSQL evidence. They
terminate replacement/recovery workers during commit, file settlement, rollback,
metadata unlink, owner unlink, marker/job removal and finalization; test live
cross-process exclusion, missing staging, unknown ownership, legacy markers and
storage loss; and exercise the resolver wrapper. These are process-crash tests,
not physical HDD power-loss tests. The local Linux/fsync, original-primary-history
and cooperating-writer assumptions above still apply.

# Destination locks (H4-A)

Storage must first satisfy the required configuration, UUID/mount and installation
marker checks in [storage configuration](storage-configuration.md). All active
locks revalidate that storage identity; a missing or changed mount is not an empty
destination. No root directory or marker is automatically provisioned.

Original-media writers coordinate through `<storageRoot>/.destination-locks/`.
An atomic mkdir claims a SHA-256 key derived from the root-relative canonical
parent path plus destination filename. Parent symlink aliases resolve to the same key; destination
symlinks and paths outside the canonical storage root are rejected. Missing paths
are keyed using their closest existing canonical ancestor. Keys remain stable
while replacement temporarily moves an original into a backup.

Each lock has an owner token and directory identity. Release checks ownership and
uses unlink/rmdir, never recursive removal of another owner's directory. A busy
destination fails immediately; unrelated destinations use separate directories.
There is no age timeout, automatic stale-lock removal, retry takeover, or global
media mutex. Deploy all processes with this protocol before accepting writes;
older application processes and external filesystem tools do not participate.
The shared filesystem must implement atomic mkdir/link/rename consistently.

Participating writers:

- Replacement holds ownership through target/metadata revalidation, backup,
  atomic publication, database update, guarded rollback, thumbnail invalidation,
  backup cleanup and N1 owned conflict-artifact reconciliation.
- Deletion acquires ownership before database deletion, rechecks the stored path,
  and holds ownership through original/thumbnail removal.
- Import finalization locks each candidate (including nonexistent candidates and
  alternate filenames), rechecks existence, and holds ownership through metadata
  insertion and staging cleanup. It never skips a busy candidate to write around
  an unresolved replacement. Existing unlocked candidates retain KEEP_BOTH naming.
- Finalized-import error cleanup no longer removes files after releasing ownership.
  Uncertain insertion failures preserve the final/staged file names for review.
- SKIP acquires the recorded destination lock before discarding staging. Legacy
  conflicts without saved destination metadata must be recovered/listed first.
  New resolution markers carry durable ownership; unknown/ownerless markers are
  never removed by SKIP. See [N1 recovery](replacement-recovery.md#staged-conflict-marker-reconciliation-n1).

Staging uploads and conflict metadata retain job/conflict coordination. Thumbnail
generation now acquires the original destination lock to serialize with replacement
invalidation. Read/preview routes do not lock. H4-C publishes via atomic rename
without a missing-target gap; transient metadata/byte differences remain possible
between publication and the PostgreSQL commit.

A successful operation releases its lock. Preflight errors before mutation also
release it. Once a filesystem/database mutation might have started, failures retain
the lock unless the caller explicitly establishes a safe completion. In particular,
H4-C uses the [replacement journal and transactional receipt](replacement-recovery.md)
under an operation-level PostgreSQL lock to reconcile failures safely. Confirmed
commit completes cleanup; definite rollback restores the original; ambiguity
retains the destination lock.
Deletion failures can likewise leave committed database deletion and remaining
files. Do not interpret a retained lock as proof that either generation committed.

## Manual recovery boundary

On a retained lock, stop writes from **all** application instances before review.
Preserve the lock directory/owner record, staged file, backups, originals, and
database evidence. Do not manually remove staged conflicts before
reviewing an unresolved operation. Compare database metadata and actual files;
resolve the outcome explicitly. Remove an abandoned lock only after confirming
there is no live owner and consistency/recovery is complete. Neither age nor PID
absence alone establishes that it is safe to clear. An explicit guarded H4-C recovery command is supplied; it never force-removes
a lock based on age.

Process death retains the destination lock. H4-B syncs replacement evidence and
uses receipts to identify committed metadata. H4-C adds explicit crash reconciliation and thumbnail invalidation. Binding an old
conflict to the exact generation the user previewed remains later work. H4-B introduces migration 0002; the applied
0001 baseline remains unchanged.

## Offline regression tests

```bash
node --import tsx scripts/destination-lock.test.ts
node --import tsx scripts/media-database.test.ts
```

Tests use fresh temporary directories, mocked metadata callbacks, and child Node
processes. They do not access configured user-media storage or PostgreSQL.

## Ordinary import publication durability

`finalizeStagedMedia` creates the destination hard link under its exclusive
canonical destination lock. Before calling the metadata callback, it uses the H4
`syncReplacementPath`/`syncParents` helpers to fsync the original inode through its
new destination, every destination ancestor up to and including the validated
storage root, and the staging parents. This includes newly created year/location
directories. The callback in `finalizeImportedMedia` invokes `insertImportedMedia`;
its PostgreSQL `COMMIT` completes inside that callback, after these filesystem
barriers. The destination stays locked through callback completion and staging
unlink. Staging parents are synchronized after unlink before releasing the lock.

A publication/sync failure prevents the metadata callback. Once publication has
started, sync failures, callback errors (including lost commit acknowledgment),
and incomplete staging cleanup retain the destination lock. The published original
is never removed as an attempted database rollback. A retry of the same destination
fails busy before selecting an alternate name. Staging may already be absent after
a cleanup-sync failure; the original still remains. Normal later job-directory or
conflict cleanup is separate and can report an error after metadata committed.

Ordinary imports still have no operation journal/commit receipt recovery protocol.
Do not use replacement/deletion recovery commands or remove these retained locks
automatically. Stop writers and independently inspect metadata, lock ownership,
and both file identities before approving a manual repair. Do not blindly replay
an import with an unknown commit outcome. Preexisting destinations still use the
existing alternate-name behavior when no destination lock is retained.

Power-loss guarantees require a local ext4/XFS filesystem and storage/controller
that correctly honor file and directory fsync and write-cache flushes. These
barriers do not make PostgreSQL and the filesystem one atomic transaction. PostgreSQL
must retain durable WAL/commit settings, and the installation must preserve the
storage root/mount and its provisioning. Disk failure, lying USB/HDD write caches,
external writers and lost filesystem/device state remain outside this guarantee;
keep tested backups and consider a UPS. Temporary-fixture tests verify syscall
ordering, injected fsync errors and worker termination; they do not simulate
physical power loss or prove actual HDD firmware behavior.

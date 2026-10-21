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
  publication, database update, rollback when attempted, and backup cleanup.
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

Staging uploads and conflict metadata retain job/conflict coordination. Thumbnail
generation writes a separate cache and does not acquire original-destination
locks; generation/invalidation races remain separate work. Read/preview routes
also do not lock, so temporary publication gaps and transient metadata/byte
differences remain possible during the existing replacement sequence.

A successful operation releases its lock. Preflight errors before mutation also
release it. Once a filesystem/database mutation might have started, failures retain
the lock unless the caller explicitly establishes a safe completion. In particular,
a replacement database error retains both generations and staging because the
PostgreSQL commit acknowledgement might have been lost. H4-B adds a durable
[replacement journal and transactional receipt](replacement-recovery.md); read-only
inspection provides evidence but does not repair files or release locks.
Deletion failures can likewise leave committed database deletion and remaining
files. Do not interpret a retained lock as proof that either generation committed.

## Manual recovery boundary

On a retained lock, stop writes from **all** application instances before review.
Preserve the lock directory/owner record, staged file, backups, originals, and
database evidence. Do not manually remove staged conflicts before
reviewing an unresolved operation. Compare database metadata and actual files;
resolve the outcome explicitly. Remove an abandoned lock only after confirming
there is no live owner and consistency/recovery is complete. Neither age nor PID
absence alone establishes that it is safe to clear. No automatic recovery or
lock-removal command is supplied.

Process death retains the destination lock. H4-B syncs replacement evidence and
uses receipts to identify committed metadata. Automatic crash reconciliation,
thumbnail invalidation, and binding an old conflict to the exact generation the
user previewed remain later H4 work. H4-B introduces migration 0002; the applied
0001 baseline remains unchanged.

## Offline regression tests

```bash
node --import tsx scripts/destination-lock.test.ts
node --import tsx scripts/media-database.test.ts
```

Tests use fresh temporary directories, mocked metadata callbacks, and child Node
processes. They do not access configured user-media storage or PostgreSQL.

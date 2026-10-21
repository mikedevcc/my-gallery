# Durable deletion tracking (M1-A)

Deletion uses the existing canonical destination lock and repeatedly validates
mounted storage. Before any database mutation it hashes the original, binds an
operation UUID to the lock, synchronizes the original and parent/lock directories,
and durably writes `.deletion-operations/<uuid>.json`. The writer is shared with
replacement journals: exclusive temporary file, file fsync, atomic rename and
parent-directory fsync. The journal records installation/filesystem identity,
media ID, canonical target, full original identity, lock token and lock directory.
A missing original is recorded explicitly as null after storage validation.

States: PREPARED -> COMMIT_PENDING -> COMMITTED -> COMPLETE. A database callback
error records COMMIT_UNKNOWN, including errors where rollback may have succeeded:
M1-A deliberately performs no receipt lookup or automatic recovery. A failed
journal write also retains the destination lock; partial temporary evidence may
require manual investigation.

Within one PostgreSQL transaction, deletion enables synchronous_commit, takes the
same operation advisory lock used by replacement recovery, validates storage and
file identity, conditionally deletes the expected media ID/path, inserts the
receipt, and validates again before COMMIT. Any precommit failure requests
ROLLBACK. A COMMIT error remains ambiguous even if a subsequent ROLLBACK succeeds.
Receipts have no media foreign key and are never automatically garbage collected.

Only acknowledged commits permit filesystem cleanup. The target identity is
checked again before unlink. Original and thumbnail cleanup is followed by parent
synchronization, durable COMPLETE state, then lock release. Successful HTTP
behavior is unchanged. Storage outages, unknown identities and persistence errors
retain the lock. Existing backup, filesystem/fsync and cooperating-writer
assumptions from H4 still apply; out-of-band writers must be stopped.

Deploy migration 0003 before this code and grant runtime INSERT privileges on the
receipt table. The receipt migration is additive; 0001 and 0002 remain immutable.

M1-B is still required: crashes can leave committed orphan files, partially
cleaned caches or an unresolved destination. Do not retry by deleting lock/journal
files, infer rollback from an absent receipt, or assume a lock is stale from age.
Keep evidence for manual investigation. Future recovery must establish stopped
ownership and acquire the same transaction advisory lock before fresh receipt
reads, validate identities before cleanup, and safely handle completed journals
whose original path has since been reused. Existing thumbnail cleanup is not a
journaled per-file recovery operation. No automatic recovery, retention cleanup,
metadata reconstruction or down migration is implemented here.

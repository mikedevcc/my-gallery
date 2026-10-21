# Original media and conflict-preview streaming (H5)

These endpoints previously buffered complete files using `readStorageFile`:

- `/api/media/[mediaId]/file` — an original selected by PostgreSQL media ID.
- `/api/import/conflict/preview?id=UUID&side=incoming|existing` — a recorded conflict preview.

Both now use `scripts/media-stream.ts` and the Node.js runtime with explicit GET
and HEAD handlers. `/api/media/[mediaId]/thumbnail` still serves its generated
thumbnail as before; thumbnail generation/cache behavior is unchanged by H5.
No new endpoint, arbitrary-path parameter, authentication mechanism, or database
schema is introduced. Existing route-level access rules remain in place.

## HTTP behavior

| Request | Response |
| --- | --- |
| GET without Range | 200 with full representation streamed in chunks |
| HEAD | 200, full-representation headers, no body and no file-data reads; Range is ignored |
| Valid single `bytes=start-end`, `bytes=start-`, or `bytes=-suffix` | 206, selected bytes, exact Content-Length and Content-Range |
| End beyond EOF / suffix larger than file | Clamp to available bytes, still 206 |
| Valid range selecting no bytes (including suffix zero or any range on empty media) | 416, `Content-Range: bytes */SIZE`, Content-Length 0, no body |
| Malformed/reversed, unsupported-unit, multiple/comma-separated, or >256-character Range | Ignore the entire Range; return full 200, never silently choose the first range |
| If-Range exactly matches the current strong generation ETag | Honor a valid single range |
| Stale/weak/date If-Range | Full 200; date validators are deliberately not treated as strong enough to distinguish same-second replacements |

Every successful representation has Content-Type, Content-Length, Accept-Ranges,
ETag, Last-Modified and nosniff headers. Originals retain inline Content-Disposition
with escaped ASCII fallback and UTF-8 filename encoding. Unknown original types
use application/octet-stream; unsupported preview types remain 415. Responses use
`private, no-store, no-transform`: intermediaries must preserve identity bytes and
Range offsets. Configure any reverse proxy to preserve streaming/cancellation and
these headers; no alternate compression representation or multipart ranges are
implemented. Conditional 304 responses are outside this change.

Invalid IDs are 400; absent/disallowed files and invalid previews are 404. Changed
metadata during open is 409. Unavailable storage or a busy/recovery destination
lock is 503 with Retry-After. Original error responses remain JSON; previews retain
plain errors. HEAD error responses have no body. Failures after headers are sent
terminate the body; they cannot retroactively change the status.

## Storage, paths and concurrent mutation

The authoritative metadata selection is repeated under a short canonical
destination lock. Storage mount UUID, installation marker and path checks remain
active. Open uses NOFOLLOW and NONBLOCK, accepts only a regular file, compares
before/open/after inode metadata and validates Linux `/proc/self/fd` against the
exact authorized path. Parent and leaf symlink aliases, traversal/noncanonical
paths, hidden/internal directories, hidden non-media metadata files and recovery
backup/publication names are
refused. The opened file must reside on the validated storage device.

Original-media requests cannot address staging, thumbnails, marker/owner files,
journals or recovery backups, even if such a path appears in metadata. Incoming
previews are the explicit exception for exactly `.incoming/<validated UUID>/<file>`:
they require the matching persisted conflict metadata, valid side, no active
conflict-resolution marker, and ownership of the conflict's original destination.
Unrecorded legacy staging needs normal conflict discovery before preview. Conflicts
retained for unresolved replacement recovery cannot be opened around its lock.

The lock is released after pinning the descriptor, **not** held for a whole video.
A replacement or deletion can then proceed while the existing stream finishes its
originally selected immutable inode. A subsequent request selects the new generation
or returns 404; it never switches an in-flight stream to another file. New opens
against an active/recovery-owned destination return 503. Simultaneous opens may
briefly contend on this same exclusive lock; callers can retry rather than bypass
it. A process crash during short-lock acquisition/release can still leave a lock
requiring the existing manual investigation procedure.

ETags identify a file generation using device/inode/size/nanosecond timestamps;
they are not full-file content digests. They prevent a stale If-Range from combining
chunks from different published generations. Previews show the current original
at open, not a historical snapshot of when the conflict was first recorded.
Binding conflict decisions to that historical generation remains separate work.

## Memory, cancellation and failure boundaries

The Web response stream pulls from Node FileHandle reads of at most 64 KiB with
zero eager queueing. Memory use is bounded per stream independently of file size;
Next.js, sockets and reverse proxies have their own bounded buffers. HEAD, empty
files and 416 close the descriptor without reading file data. Request AbortSignal,
response-body cancellation, EOF and read/validation errors all close the descriptor
and detach the abort listener. Next.js's installed Node response bridge propagates
client disconnects to cancellation; a loopback test exercises that exact bridge.

Storage is revalidated for every chunk. Device disappearance or in-place size/mtime
changes stop delivery. Participating writers publish by rename/unlink, never by
editing a pinned inode. Privileged/nonparticipating local writers, broken hardware,
and hung kernel HDD I/O are outside the protocol; cancellation initiates close but
cannot forcibly interrupt an outstanding kernel I/O operation. Linux `/proc` must
remain available to the Node service. Files above Number.MAX_SAFE_INTEGER bytes
are rejected rather than using imprecise offsets.

## Fixture-only verification

```sh
node --import tsx scripts/media-stream.test.ts
node --import tsx scripts/media-routes.test.ts
node --import tsx scripts/media-stream-http.test.ts
```

Tests mock storage probes and all PostgreSQL checkouts. They use temporary files,
a sparse 1 GiB fixture and an ephemeral loopback HTTP server. They cover range
semantics, both routes, metadata/path rejection, streaming during replacement and
deletion, cancellation, descriptor cleanup and storage loss. They do not connect
to PostgreSQL or access configured user media. The loopback test needs permission
to bind a local ephemeral port; child-process regression suites likewise need an
environment that supports subprocess communication.

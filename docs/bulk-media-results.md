# Per-item bulk media results (M7)

Bulk deletion, Album picker addition, Album removal and Trip removal still use
separate existing requests for each ID. They are not atomic batches. Trip bulk
assignment/move and Album transactional move/copy APIs are unchanged and are not
split into per-item requests by this implementation. Database, filesystem,
receipts, journals and recovery semantics are unchanged.

The client deduplicates selected IDs and keeps a session ledger of confirmed,
failed, uncertain, processing and not-attempted IDs. A confirmed public success response removes
only its IDs from the current selection. Album `addedCount: 0` is a confirmed
already-present membership, reported separately from newly added membership.
The dialog stays open to show counts; close it explicitly after reviewing results.
Failures do not cancel unrelated later IDs. A user-triggered retry processes only
rejected or not-attempted selected IDs, skipping confirmed and uncertain IDs.
Unselecting/reselecting an uncertain ID cannot unblock it. Verified available
members explicitly selected for a new operation may clear earlier confirmed
results, permitting a later legitimate add/remove after membership changed.

Known 400/401/403/404/409/413/415/422 rejections are classified as failed under the
current route contracts: they do not confirm a committed mutation. Review and
resolve their cause before manually retrying. Network/read errors, redirects,
invalid success DTOs, 408, 429, 5xx and unexpected statuses remain uncertain. A
server may already have committed before returning an error, particularly when
media filesystem cleanup requires recovery. A missing/malformed response does not
prove rollback, and 404 is not counted as this request successfully deleting media.
Public feedback uses local labels and IDs, never raw server exceptions or paths.

Each attempted batch emits one `media-library-updated` event, even if its first
item fails or it contains uncertain outcomes. Selection callbacks only update
confirmed IDs; they do not trigger a second refresh. Album/Trip manual refreshes
and event refreshes share cancellation and generation checks. Failed refreshes
preserve the previous view, selections and result feedback, with a visible error.

Concurrent clicks cannot enter one batch twice. On component unmount or collection
scope change, later IDs stop being scheduled and UI callbacks are suppressed. The
already-sent mutation is not aborted: its response may still confirm a commit,
and a global refresh is still emitted after it settles. The session ledger records
unattempted remaining IDs. Pending/uncertain request markers are written before
sending, using tab-scoped `sessionStorage` and an in-memory navigation fallback.
They survive modal remount and (when storage works) page reload; an interrupted
request cannot silently become a fresh retry. Scope includes operation and target
collection. These markers contain IDs/outcome warnings, not credentials or paths.

## Review and limitations

For uncertain IDs, inspect the refreshed collection/library and relevant server
logs; media deletion may need the existing administrator receipt/journal recovery
procedure. Do not retry merely because the file is missing or the client timed out.
The UI deliberately provides no uncertainty override. After independently verifying
server state/recovery, start a fresh reviewed session; closing the browser tab
ends its sessionStorage namespace. Do not clear browser evidence before recording
which IDs need review. If browser storage is unavailable, reload/tab closure loses
the memory-only ledger. Separate tabs do not share these client guards; server
locks and transaction constraints remain authoritative. There is no new server
idempotency protocol or automatic recovery.

An in-flight request can outlive navigation and can remain uncertain indefinitely
when the network never settles. Browser feedback records the outcome it can prove,
not a cross-system atomic guarantee. Proxy changes must preserve rejection semantics;
a proxy that rewrites mutation responses after upstream commit needs separate
review. Browser interaction, focus/layout and representative proxy failures need
a manual smoke test. Automated coverage uses mocked requests/in-memory marker
storage, deferred responses, unmount simulation and rendered feedback markup.

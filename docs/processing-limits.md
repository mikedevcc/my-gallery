# Media processing limits (M13)

The import API streams multipart data through Busboy to exclusively created files
on validated media storage. It does not call `formData()` or buffer whole uploads.
File bytes, total request bytes (including multipart overhead), fields and elapsed
time are limited even without Content-Length. The browser import queue remains
sequential. There is no additional server background queue: imports, conflict
resolution/list recovery, and thumbnail generation use bounded job admission;
excess work gets HTTP 503 with `Retry-After: 5`. The current UI reports that error;
retry manually. No automatic retry can duplicate an uncertain mutation.

All numeric environment variables below must be positive decimal safe integers.
Invalid configuration fails closed when processing is attempted. Restart Node
after configuration changes. Values in bytes use binary MiB/GiB.

| Variable | Default | Meaning |
| --- | ---: | --- |
| `MEDIA_MAX_UPLOAD_BYTES` | 536870912 (512 MiB) | Individual incoming file |
| `MEDIA_MAX_REQUEST_BYTES` | upload limit + 65536 | Entire multipart request; must cover file limit |
| `MEDIA_MAX_CONCURRENT_JOBS` | 2 | Active expensive jobs; no waiting queue |
| `MEDIA_MAX_SUBPROCESSES` | 2 | Active ExifTool/FFmpeg children; no waiting queue |
| `MEDIA_MAX_TEMP_BYTES` | 2147483648 (2 GiB) | Staging and unfinished-thumbnail admission budget |
| `MEDIA_MIN_FREE_BYTES` | 1073741824 (1 GiB) | Free-disk floor plus current reservations at admission |
| `MEDIA_UPLOAD_TIMEOUT_MS` | 120000 | Entire multipart parsing/staging deadline |
| `MEDIA_SUBPROCESS_TIMEOUT_MS` | 60000 | Each ExifTool/FFmpeg child deadline |
| `MEDIA_SUBPROCESS_OUTPUT_BYTES` | 1048576 (1 MiB) | Combined stdout/stderr per child |
| `MEDIA_MAX_IMAGE_PIXELS` | 40000000 | Sharp input pixel ceiling |
| `MEDIA_MAX_THUMBNAIL_BYTES` | 16777216 (16 MiB) | Exclusive upper bound for completed thumbnails |

Other fixed bounds: one file and one jobId field, jobId at most 1024 bytes;
conflict JSON at most 4096 bytes within 10 seconds; reverse geocoding defaults to
10 seconds with at most 64 KiB of response JSON. Its URL, mode and timeout are
configured as described in [production deployment](deployment.md). Multipart headers also have Busboy's bounded header parser. Existing
accepted file extensions are unchanged; unsupported extensions return 415.
Oversized requests/files return 413, malformed input 400, cancellation/upload
timeouts 408, unavailable capacity 503, insufficient free disk 507, failed tools
or excessive tool output 422, and subprocess deadlines 504. Tool stderr is consumed
within the output ceiling and not sent to clients. Storage/path/DB errors retain
their existing failure handling (normally 500).

A staging admission reserves the maximum permitted upload, not its reported
Content-Length. Retained conflicts and interrupted uploads count against the
budget; active reservations may also be counted as actual written bytes, which is
intentionally conservative. Unfinished `.tmp.webp` thumbnails count too. More
than 10000 staging/temporary artifacts blocks new admissions for maintenance.
Set the budget large enough for two reservations plus retained conflicts. This
budget does not expire, erase or recover conflicts, journals, locks or backups.
Existing originals, completed thumbnail caches and recovery evidence are not
subject to automatic eviction. The free-space floor is an admission check, not a
filesystem quota; external writers can consume disk afterwards.

New staging directories contain an exclusively created `.uploading` marker until
the complete multipart request has been validated. Conflict listing, previews and
resolution reject/skip these directories. A crash leaves the marker and bytes
invisible and counted against capacity. Investigate them manually with the app
stopped; never remove markers solely because they are old. No original or media
metadata is published before preprocessing succeeds. Once original publication or
a replacement transaction begins, cancellation no longer interrupts the mutation;
destination locks and the existing receipt/journal protocol govern its outcome.

Children run without a shell, with stdin closed. Timeout, cancellation and output
overflow terminate their process group with SIGTERM, escalating to SIGKILL after
one second on Debian. Slots remain occupied until child teardown completes.
ExifTool uses this wrapper for all metadata calls. FFmpeg additionally uses one
decoder, filter and encoder thread and an output-file size limit. FFprobe is not
currently invoked. Image thumbnails use one libvips worker thread per process,
input pixel bounds and Sharp's native timeout (rounded up to seconds, capped at
3600). Sharp cancellation is cooperative; it cannot forcibly interrupt every
native codec. The job stays admitted until native processing finishes, then
cancellation prevents publication. Complete thumbnails are hard-linked atomically
from exclusive temporary files while holding the original's destination lock;
failed/cancelled processing cannot expose a partial cache entry.

Failed-upload cleanup checks directory/file ownership identities and removes only
known files, then uses nonrecursive `rmdir`. Thumbnail cleanup likewise checks its
created inode. Changed paths, unexpected artifacts or unavailable storage are
retained for investigation. Native codec timeouts and request deadlines cannot
interrupt kernel I/O blocked on a failing HDD. Crash recovery remains the explicit maintenance
workflow; no startup cleanup or automatic deletion of retained evidence was added.

## Debian deployment

Run one production Node process for these application admission counts. Counts and
reservations are process-local; additional Next workers/processes or installations
sharing storage multiply capacity and can race quota scans. Destination locks
remain cross-process, but resource admission is not a distributed scheduler.
Use independent storage roots per installation. A filesystem quota and systemd
`MemoryMax`, `CPUQuota`, `TasksMax`, `LimitNOFILE` and service restart policy provide
hard OS-level bounds, including native decoder memory and external writers.
Keep HDD mount validation and local-filesystem requirements in force.

Configure your reverse proxy's upload/body limit to cover the configured request
limit (e.g. nginx `client_max_body_size 513m` for these defaults), client-body/read
timeouts, and a proxy response timeout sufficient for several sequential metadata
calls plus safe database finalization. Disable proxy request buffering if uploads
must stream directly; otherwise explicitly bound/place proxy temporary storage.
Next Server Actions body-size configuration does not govern these App Router
handlers. No Next proxy/middleware that clones upload bodies is currently used;
review any future middleware's buffering behavior. Framework/proxy buffers and
kernel page cache are outside the application staging budget.

Set conservative values for the mini PC; test representative codecs before
raising them. Application extension checks and tool deadlines are not a sandbox
for codec vulnerabilities: keep ExifTool, FFmpeg, Sharp and Node patched, restrict
service permissions, and use OS limits. No real-media performance benchmark or
production database test is part of the offline regression suite.

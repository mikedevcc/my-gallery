# Supported media formats (M11-B)

`lib/media-formats.ts` is the shared policy for the file picker, client queue,
server admission, content validation, original MIME selection and conflict
preview eligibility. The
picker uses extensions, not `image/*,video/*`. Browser-supplied MIME headers are
untrusted and can be absent; they do not override the policy.

## Format matrix

| Format/extensions (case insensitive) | New imports | Original/preview browser delivery |
| --- | --- | --- |
| JPEG `.jpg`, `.jpeg` | Yes, image/jpeg | image/jpeg |
| PNG `.png` | Yes, image/png | image/png |
| GIF `.gif` | Yes, image/gif | image/gif; thumbnail uses first frame |
| WebP `.webp` | Yes, image/webp | image/webp |
| AVIF `.avif` | Yes, image/avif | image/avif; needs browser AVIF support |
| TIFF `.tif`, `.tiff` | Yes, image/tiff | Original octet-stream/download; no conflict preview |
| MP4 `.mp4` | Yes, video/mp4 | video/mp4; codec-dependent |
| QuickTime `.mov` | Yes, video/quicktime | video/quicktime; browser/codec-dependent |
| WebM `.webm` | Yes, video/webm | video/webm; codec-dependent |
| AVI `.avi` | Yes, video/x-msvideo | Original octet-stream/download; no conflict preview |
| Matroska `.mkv` | Yes, video/x-matroska | Original octet-stream/download; no conflict preview |
| WMV `.wmv` | Yes, video/x-ms-wmv | Original octet-stream/download; no conflict preview |
| SVG, RAW, HEIF/HEIC, BMP, other extensions | No | Previously stored originals retain existing delivery |

Admission requires an extension/MIME match detected by ExifTool, no ExifTool error,
and a successful bounded decode on this installation. A container extension is
not a guarantee that the installed FFmpeg has its decoder, or that a browser can
play its video/audio codecs. Unsupported, damaged, mismatched or over-limit media
returns HTTP 415 with a static public message; no raw decoder output or paths
are exposed. Missing tools/overload remain 503, subprocess deadlines 504 and cancellation
408. Native image decoder-limit failures are rejected with 415. Network/request failures retain the existing uncertain-outcome behavior.

## Validation and processing

Validation runs inside `importMedia` before geocoding, publication, database
insertion or replacement mutation. It also covers CLI imports and conflict
reprocessing. ExifTool detection does not trust uploaded Content-Type. Images
must decode through Sharp's first-page/frame pipeline with the existing input
pixel and native timeout bounds; a small 8x8 result is discarded. TIFF is
first-page only. Video dimensions must be positive and within the image-pixel
ceiling. FFmpeg must decode a video frame and return its checksum (no media file
is written). The selected container's demuxer allowlist and file/pipe protocol
allowlist reject playlists and network input; MOV external data references remain
disabled by FFmpeg's default. Thread, child-output, timeout and cancellation
limits reuse the existing processing guard. No original is transcoded. Video thumbnails now use the first frame rather than
seeking one second in, so short clips are supported too. Their decoder also uses
the shared demuxer policy for known formats and the file/pipe protocol allowlist.

Full animation/video integrity, every video/audio stream, later frames, HDR,
colour profiles and browser codec compatibility are not certified by a first-frame
check. Valid files with missing dimension metadata, an unavailable decoder,
strict-decoder warnings or mismatched extensions fail conservatively. An upload
may stage before content validation, but cannot publish successfully before it
passes. Existing guarded cleanup handles failed staging. No native decoder is a
security sandbox: keep Sharp/libvips, ExifTool and FFmpeg patched, use a restricted
service account and retain the deployment resource limits.

Sharp documents its supported image inputs in the [constructor reference](https://sharp.pixelplumbing.com/api-constructor/).
FFmpeg documents [protocol allowlists](https://ffmpeg.org/ffmpeg-protocols.html)
and its [demuxer allowlist](https://github.com/FFmpeg/FFmpeg/blob/master/libavformat/options_table.h).

## Stored-media compatibility and browser limits

No records, files, extensions or directories are rewritten. New-admission policy
is deliberately separate from reads: stored RAW/HEIF/SVG and other legacy files
retain octet-stream original access, while existing thumbnail generation can
still attempt its previous decoder path. Thumbnail failures for old unsupported
files are not repaired by this change. SVG is never given an active same-origin
SVG MIME type. Original responses preserve their existing Content-Disposition,
nosniff and Range semantics; unknown types use application/octet-stream and their
previews return 415. Browser download behavior may vary.

TIFF/AVI/MKV/WMV can be archived and have thumbnails when the native decoder
supports them, but the current original lightbox/preview may not display them.
Even MP4, MOV and WebM playback depends on the contained codecs and the browser;
no universal browser-playback promise is made. Incompatible originals can be
retrieved through the existing original endpoint for an external viewer. V2 can
add explicitly designed transcoding/preview derivatives, codec-aware UI or a
broader decoder policy. HEIF/HEIC and RAW new imports are deferred because decoder
availability is not consistent across self-hosted installations; SVG is excluded
from new imports as active content.

## Verification

Offline regression tests use generated image fixtures, mocked tool executables,
mocked PostgreSQL checkout (which rejects any attempted connection), temporary
storage markers and simulated mounts. The real-tool suite additionally tests
all admitted containers and image families, their WebP thumbnails (including
sub-second videos), mismatched content, renamed files
and invalid input with installed ExifTool/Sharp/FFmpeg:

```sh
MEDIA_FORMAT_TOOLS_TEST=1 node --import tsx --test scripts/media-formats.test.ts
```

All fixtures are temporary. This command does not connect to PostgreSQL or use
configured media storage. Real-tool testing is opt-in so installations without
native tools can still run the offline suite; deployment must run it with the
service's actual tool builds.

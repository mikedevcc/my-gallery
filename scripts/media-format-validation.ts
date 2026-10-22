import sharp from "sharp";
import type { MediaFormat } from "../lib/media-formats";
import { unsupportedMediaMessage } from "../lib/media-formats";
import { ProcessingError, processingLimits, processingSignal, checkProcessingCancellation } from "./processing-limits";
import { runMediaSubprocess } from "./media-subprocess";
import { logApiFailure } from "./api-diagnostics";

/** Only used for NEW imports, before metadata publication. Stored originals retain
 * their existing read/thumbnail paths, including formats no longer admitted.
 */
export async function validateMediaContents(filePath: string, format: MediaFormat, metadata: Record<string, unknown>) {
    checkProcessingCancellation();
    if (metadata.Error || typeof metadata.MIMEType !== "string" || !format.detectedMimes.includes(metadata.MIMEType)) {
        throw new ProcessingError(unsupportedMediaMessage, 415);
    }
    const limits = processingLimits();
    try {
        if (format.kind === "IMAGE") {
            // Decode the first page/frame, not merely its header. No persistent
            // derivative is published and output memory is at most an 8x8 image.
            const image = sharp(filePath, { limitInputPixels: limits.pixels, sequentialRead: true, pages: 1, failOn: "warning" })
                .timeout({ seconds: Math.min(3600, Math.ceil(limits.subprocessMs / 1000)) })
                .resize({ width: 8, height: 8, fit: "inside" }).png();
            const signal = processingSignal();
            const abort = () => image.destroy(new ProcessingError("Media processing cancelled", 408));
            signal?.addEventListener("abort", abort, { once: true });
            try {
                checkProcessingCancellation();
                await image.toBuffer();
            } finally {
                signal?.removeEventListener("abort", abort);
                image.destroy();
            }
        } else {
            const width = metadata.ImageWidth, height = metadata.ImageHeight;
            if (typeof width !== "number" || typeof height !== "number" || !Number.isSafeInteger(width) || !Number.isSafeInteger(height)
                || width <= 0 || height <= 0 || width * height > limits.pixels) throw new ProcessingError(unsupportedMediaMessage, 415);
            // Reject playlists/other demuxers even if named .mp4. No network
            // protocols, external MOV references or persistent transcoded output.
            const { stdout } = await runMediaSubprocess("ffmpeg", [
                "-nostdin", "-v", "error", "-xerror", "-threads", "1", "-filter_threads", "1",
                "-protocol_whitelist", "file,pipe", "-format_whitelist", format.demuxers!,
                "-i", filePath, "-map", "0:v:0", "-frames:v", "1", "-an", "-sn", "-dn",
                "-vf", "scale=8:8", "-threads", "1", "-f", "framemd5", "pipe:1",
            ]);
            if (!/^0,\s*\d+,/m.test(stdout)) throw new ProcessingError(unsupportedMediaMessage, 415);
        }
        checkProcessingCancellation();
    } catch (error) {
        checkProcessingCancellation();
        if (error instanceof ProcessingError && [408, 503, 504].includes(error.status)) throw error;
        logApiFailure("import-format-validation", error);
        if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ProcessingError("Media decoder unavailable", 503);
        throw new ProcessingError(unsupportedMediaMessage, 415);
    }
}

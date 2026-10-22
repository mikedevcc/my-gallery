/** Shared admission policy. MIME values from upload headers are never authoritative.
 * `inlineMime` preserves the existing delivery policy, independently of admission.
 */
export type MediaFormat = {
    extensions: readonly string[];
    kind: "IMAGE" | "VIDEO";
    detectedMimes: readonly string[];
    inlineMime?: string;
    demuxers?: string;
};

export const mediaFormats: readonly MediaFormat[] = [
    { extensions: [".jpg", ".jpeg"], kind: "IMAGE", detectedMimes: ["image/jpeg"], inlineMime: "image/jpeg" },
    { extensions: [".png"], kind: "IMAGE", detectedMimes: ["image/png"], inlineMime: "image/png" },
    { extensions: [".gif"], kind: "IMAGE", detectedMimes: ["image/gif"], inlineMime: "image/gif" },
    { extensions: [".webp"], kind: "IMAGE", detectedMimes: ["image/webp"], inlineMime: "image/webp" },
    { extensions: [".avif"], kind: "IMAGE", detectedMimes: ["image/avif"], inlineMime: "image/avif" },
    { extensions: [".tif", ".tiff"], kind: "IMAGE", detectedMimes: ["image/tiff"] },
    { extensions: [".mp4"], kind: "VIDEO", detectedMimes: ["video/mp4"], inlineMime: "video/mp4", demuxers: "mov" },
    { extensions: [".mov"], kind: "VIDEO", detectedMimes: ["video/quicktime"], inlineMime: "video/quicktime", demuxers: "mov" },
    { extensions: [".webm"], kind: "VIDEO", detectedMimes: ["video/webm"], inlineMime: "video/webm", demuxers: "matroska,webm" },
    { extensions: [".avi"], kind: "VIDEO", detectedMimes: ["video/x-msvideo"], demuxers: "avi" },
    { extensions: [".mkv"], kind: "VIDEO", detectedMimes: ["video/x-matroska"], demuxers: "matroska,webm" },
    { extensions: [".wmv"], kind: "VIDEO", detectedMimes: ["video/x-ms-wmv"], demuxers: "asf" },
];

export const unsupportedMediaMessage = "Unsupported or invalid media. Choose a supported image or video file.";
export const mediaUploadAccept = mediaFormats.flatMap(format => format.extensions).join(",");

export function mediaFormat(fileName: string): MediaFormat | undefined {
    // This is format selection, not path authorization (handled separately).
    const leaf = fileName.split(/[\\/]/).at(-1) ?? "";
    const dot = leaf.lastIndexOf(".");
    const extension = dot <= 0 ? "" : leaf.slice(dot).toLowerCase();
    return mediaFormats.find(format => format.extensions.includes(extension));
}

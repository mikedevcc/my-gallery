import path from "node:path";
import type { ImportConflict, PublicImportConflict } from "../lib/import/import-conflict";

function fields(value: object, names: readonly string[]): Record<string, unknown> {
    const row = value as Record<string, unknown>;
    return Object.fromEntries(names.filter(name => Object.hasOwn(row, name)).map(name => [name, row[name]]));
}
export function publicMedia(value: object) {
    const dto = fields(value, ["media_id", "file_name", "file_type", "file_size", "date_taken", "capture_local", "capture_offset_minutes", "file_modified_at", "file_modified_timezone", "date_imported", "width", "height", "favorite",
        "city_name", "country_name", "aperture", "iso", "exposure_time", "focal_length_mm", "focal_length_35mm", "flash", "white_balance",
        "duration_seconds", "frame_rate", "video_codec", "audio_codec", "bitrate"]);
    // Legacy metadata may have stored a full path in the filename column.
    // Display a filename only; internal filesystem selection remains unchanged.
    if (typeof dto.file_name === "string") dto.file_name = path.win32.basename(path.basename(dto.file_name));
    return dto;
}
export function publicCollection(value: object, kind: "trip" | "album") {
    return fields(value, [`${kind}_id`, `${kind}_name`, "media_count", "cover_media_id"]);
}
export function publicImportConflict(value: ImportConflict): PublicImportConflict {
    const common = { jobId: value.jobId, conflictId: value.conflictId, existingMediaId: value.existingMediaId };
    if (value.type === "FILENAME") return { ...common, type: "FILENAME", existingFilename: path.win32.basename(path.basename(value.existingPath)) };
    return { ...common, type: "HASH", existingMediaId: value.existingMediaId };
}

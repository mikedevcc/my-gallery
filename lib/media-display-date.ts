
import {
    captureCalendar,
    formatCaptureDate,
    type CaptureDateFields,
} from "./media-capture-date";

export type MediaDisplayDateFields = CaptureDateFields & {
    file_modified_at?: string | null;
    file_modified_timezone?: string | null;
    date_imported?: string | null;
};

/**
 * Validate a saved IANA timezone.
 *
 * Legacy records may not have a timezone, so UTC is used
 * instead of assuming the viewer's current timezone.
 */
export function validTimezone(
    value: string | null | undefined
): string {
    if (!value) return "UTC";

    try {
        return new Intl.DateTimeFormat("en-GB", {
            timeZone: value,
        }).resolvedOptions().timeZone;
    } catch {
        return "UTC";
    }
}

/**
 * Format an absolute timestamp in a specified timezone.
 */
function formatTimestamp(
    value: string | null | undefined,
    label: string,
    timeZone: string
): string | undefined {
    if (!value) return undefined;

    const date = new Date(value);

    if (!Number.isFinite(date.getTime())) {
        return undefined;
    }

    return `${label}: ${date.toLocaleString("en-GB", {
        timeZone,
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    })}`;
}

/**
 * Display the most reliable available media date.
 *
 * Priority:
 * 1. Original capture date (EXIF/video metadata)
 * 2. Original file modification date
 * 3. Import date
 *
 * Camera-local timestamps retain their original meaning.
 * File modification timestamps use the timezone saved
 * from the uploading device.
 */
export function formatMediaDisplayDate(
    media: MediaDisplayDateFields
): string {
    // Preserve the existing camera-local date behavior.
    if (captureCalendar(media)) {
        return `Captured: ${formatCaptureDate(media)}`;
    }

    // Interpret the file modification timestamp using
    // the timezone recorded when the file was uploaded.
    const fileTimezone = validTimezone(
        media.file_modified_timezone
    );

    const modifiedDate = formatTimestamp(
        media.file_modified_at,
        "File modified",
        fileTimezone
    );

    if (modifiedDate) {
        return modifiedDate;
    }

    // Last fallback for media without usable date metadata.
    return (
        formatTimestamp(
            media.date_imported,
            "Imported",
            "UTC"
        ) ?? "Date unknown"
    );
}

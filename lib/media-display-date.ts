
import {
    captureCalendar,
    formatCaptureDate,
    type CaptureDateFields,
} from "./media-capture-date";

export type MediaDisplayDateFields = CaptureDateFields & {
    file_modified_at?: string | null;
    date_imported?: string | null;
};

function formatTimestamp(
    value: string | null | undefined,
    label: string,
    timeZone: string
): string | undefined {
    if (!value) return undefined;

    const date = new Date(value);

    if (!Number.isFinite(date.getTime())) return undefined;

    return `${label}: ${date.toLocaleString("en-GB", {
        timeZone,
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    })}`;
}

export function formatMediaDisplayDate(
    media: MediaDisplayDateFields,
    timeZone = "UTC"
): string {
    if (captureCalendar(media)) {
        return `Captured: ${formatCaptureDate(media)}`;
    }

    return (
        formatTimestamp(
            media.file_modified_at,
            "File modified",
            timeZone
        ) ??
        formatTimestamp(
            media.date_imported,
            "Imported",
            timeZone
        ) ??
        "Date unknown"
    );
}

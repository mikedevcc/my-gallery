
import {
    captureCalendar,
    type CaptureDateFields,
} from "./media-capture-date";
import { validTimezone } from "./media-display-date";

export type GroupMode = "All" | "Years" | "Months" | "Days";

export type DateGroupableMedia = CaptureDateFields & {
    file_modified_at?: string | null;
    file_modified_timezone?: string | null;
    date_imported?: string | null;
};

function validTimestamp(value: string | null | undefined): Date | undefined {
    if (!value) return undefined;

    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : undefined;
}

export function getMediaDate(item: DateGroupableMedia): Date | undefined {
    return (
        captureCalendar(item)?.clock ??
        validTimestamp(item.file_modified_at) ??
        validTimestamp(item.date_imported)
    );
}

export function groupMediaByDate<T extends DateGroupableMedia>(
    items: T[],
    mode: GroupMode
): [string, T[]][] {
    if (mode === "All") return [["All", items]];

    const groups = new Map<string, T[]>();

    for (const item of items) {
        const capture = captureCalendar(item);
        const date = getMediaDate(item);

        const timeZone = capture
            ? "UTC"
            : validTimestamp(item.file_modified_at)
                ? validTimezone(item.file_modified_timezone)
                : "UTC";

        const key = !date
            ? "Date unknown"
            : date.toLocaleDateString("en-GB", {
                timeZone,
                year: "numeric",
                ...(mode === "Years" ? {} : { month: "long" as const }),
                ...(mode === "Days" ? { day: "numeric" as const } : {}),
            });

        const existing = groups.get(key);

        if (existing) existing.push(item);
        else groups.set(key, [item]);
    }

    return Array.from(groups.entries());
}

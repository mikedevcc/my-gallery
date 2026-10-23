import { captureCalendar, type CaptureDateFields } from "./media-capture-date";

export type GroupMode = 'All' | 'Years' | 'Months' | 'Days';

export type DateGroupableMedia = CaptureDateFields & {
    file_modified_at?: string | null;
    date_imported?: string | null;
};

function validTimestamp(value: string | null | undefined): Date | undefined {
    if (!value) return undefined;

    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : undefined;
}

export function getMediaDate(item: DateGroupableMedia): Date | undefined {
    const captured = captureCalendar(item);
    if (captured) return captured.clock;
    return (
        validTimestamp(item.file_modified_at) ??
        validTimestamp(item.date_imported)
    );
}

export function groupMediaByDate<T extends DateGroupableMedia>(items: T[], mode: GroupMode): [string, T[]][] {
    if (mode === 'All') return [['All', items]];
    const groups = new Map<string, T[]>();
    for (const item of items) {
        const date = getMediaDate(item);
        const key = !date ? 'Capture date unknown' : date.toLocaleDateString('en-GB', {
            timeZone: 'UTC', year: 'numeric',
            ...(mode === 'Years' ? {} : { month: 'long' as const }),
            ...(mode === 'Days' ? { day: 'numeric' as const } : {}),
        });
        const existing = groups.get(key);
        if (existing) existing.push(item);
        else groups.set(key, [item]);
    }
    return Array.from(groups.entries());
}

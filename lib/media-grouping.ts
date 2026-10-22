import { captureCalendar, type CaptureDateFields } from "./media-capture-date";

export type GroupMode = 'All' | 'Years' | 'Months' | 'Days';
export type DateGroupableMedia = CaptureDateFields & { date_imported?: string };

// Calendar carrier for formatting only; missing capture dates stay missing.
export function getMediaDate(item: DateGroupableMedia): Date | undefined {
    return captureCalendar(item)?.clock;
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

export type GroupMode =
    | 'All'
    | 'Years'
    | 'Months'
    | 'Days';

export type DateGroupableMedia = {
    date_taken: string | null;
    date_imported?: string;
};


export function getMediaDate(
    item: DateGroupableMedia
): Date {
    return new Date(
        item.date_taken ??
        item.date_imported ??
        Date.now()
    );
}

export function groupMediaByDate<T extends DateGroupableMedia>(
    items: T[],
    mode: GroupMode
): [string, T[]][] {
    if (mode === 'All') {
        return [['All', items]];
    }

    const groups = new Map<string, T[]>();

    for (const item of items) {
        const date = getMediaDate(item);

        let key: string;

        if (mode === 'Years') {
            key = date.toLocaleDateString(
                'en-GB',
                {
                    year: 'numeric',
                }
            );
        }
        else if (mode === 'Months') {
            key = date.toLocaleDateString(
                'en-GB',
                {
                    month: 'long',
                    year: 'numeric',
                }
            );
        }
        else {
            key = date.toLocaleDateString(
                'en-GB',
                {
                    day: 'numeric',
                    month: 'long',
                    year: 'numeric',
                }
            );
        }

        const existing = groups.get(key);

        if (existing) {
            existing.push(item);
        }
        else {
            groups.set(key, [item]);
        }
    }

    return Array.from(groups.entries());
}
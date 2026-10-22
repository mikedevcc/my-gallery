/** Camera wall time and an optional known instant are different facts. */
export type CaptureDate = {
    captureLocal: string;
    captureOffsetMinutes?: number;
    dateTaken?: Date;
};

function offsetMinutes(raw: string): number | undefined {
    if (raw === "Z") return 0;
    const match = /^([+-])(\d{2}):?(\d{2})$/.exec(raw);
    if (!match) return undefined;
    const hours = Number(match[2]), minutes = Number(match[3]);
    if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0)) return undefined;
    return (match[1] === "-" ? -1 : 1) * (hours * 60 + minutes);
}

export function parseCaptureDate(raw: string, offsetHint?: string): CaptureDate | undefined {
    const match = /^(\d{4})([:-])(\d{2})\2(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?$/.exec(raw.trim());
    if (!match) return undefined;
    const [year, month, day, hour, minute, second] = [match[1], match[3], match[4], match[5], match[6], match[7]].map(Number);
    if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return undefined;
    const milliseconds = Number((match[8] ?? "").padEnd(3, "0").slice(0, 3));
    // UTC is used ONLY as an arithmetic/formatting carrier for calendar fields.
    // It does not assign a timezone or invent an instant for a naive camera clock.
    const clock = new Date(0);
    clock.setUTCFullYear(year, month - 1, day);
    clock.setUTCHours(hour, minute, second, milliseconds);
    if (clock.getUTCFullYear() !== year || clock.getUTCMonth() !== month - 1 || clock.getUTCDate() !== day) return undefined;
    const captureLocal = clock.toISOString().slice(0, -1);
    const rawOffset = match[9] ?? offsetHint?.trim();
    if (rawOffset === undefined) return { captureLocal };
    const captureOffsetMinutes = offsetMinutes(rawOffset);
    if (captureOffsetMinutes === undefined) return undefined;
    const dateTaken = new Date(clock.getTime() - captureOffsetMinutes * 60_000);
    if (dateTaken.getUTCFullYear() < 1 || dateTaken.getUTCFullYear() > 9999) return undefined;
    return { captureLocal, captureOffsetMinutes, dateTaken };
}

export function captureDateFromExif(metadata: Record<string, unknown>): CaptureDate | undefined {
    const text = (key: string) => typeof metadata[key] === "string" && (metadata[key] as string).trim() ? metadata[key] as string : undefined;
    for (const [field, offset] of [
        ["SubSecDateTimeOriginal", "OffsetTimeOriginal"],
        ["DateTimeOriginal", "OffsetTimeOriginal"],
        ["SubSecCreateDate", "OffsetTimeDigitized"],
        ["CreateDate", "OffsetTimeDigitized"],
    ]) {
        const raw = text(field);
        if (raw !== undefined) return parseCaptureDate(raw, text(offset) ?? text("OffsetTime"));
    }
    return undefined;
}

export type CaptureDateFields = {
    date_taken: string | null;
    capture_local?: string | null;
    capture_offset_minutes?: number | null;
};

export function captureCalendar(item: CaptureDateFields): { clock: Date; legacy: boolean; offset?: number } | undefined {
    if (item.capture_local != null) {
        const parsed = parseCaptureDate(item.capture_local);
        if (!parsed || parsed.dateTaken) return undefined; // A wall-clock DTO must have no zone suffix.
        const carrier = parseCaptureDate(parsed.captureLocal, "Z")!;
        return { clock: carrier.dateTaken!, legacy: false, offset: item.capture_offset_minutes ?? undefined };
    }
    // Legacy TIMESTAMPTZ values no longer contain the original clock/offset.
    if (!item.date_taken) return undefined;
    const parsed = parseCaptureDate(item.date_taken);
    if (!parsed?.dateTaken) return undefined;
    return { clock: parsed.dateTaken, legacy: true };
}

export function formatCaptureDate(item: CaptureDateFields): string {
    const calendar = captureCalendar(item);
    if (!calendar) return "Capture date unknown";
    const label = calendar.clock.toLocaleString("en-GB", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
    if (calendar.legacy) return `${label} (legacy UTC; original timezone unknown)`;
    if (calendar.offset === undefined) return `${label} (timezone unknown)`;
    const sign = calendar.offset < 0 ? "-" : "+";
    const absolute = Math.abs(calendar.offset);
    return `${label} (UTC${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")})`;
}

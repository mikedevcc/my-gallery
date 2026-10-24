import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCaptureDate, captureDateFromExif, captureCalendar, formatCaptureDate } from "../lib/media-capture-date";

const zones = ["UTC", "Asia/Singapore", "America/Los_Angeles"];
function inZone(zone: string, work: () => void) { const previous = process.env.TZ; process.env.TZ = zone; try { work(); } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; } }

for (const zone of zones) test(`camera calendars and explicit instants are independent of process timezone: ${zone}`, () => inZone(zone, () => {
    for (const raw of ["2026:01:01 00:15:00", "2026:07:01 23:59:59", "2026:03:08 02:30:00", "2026:11:01 01:30:00"]) {
        const capture = parseCaptureDate(raw)!;
        assert.equal(capture.captureLocal, raw.replace(/^(\d{4}):(\d{2}):(\d{2}) /, "$1-$2-$3T") + ".000");
        assert.equal(capture.dateTaken, undefined); assert.equal(capture.captureOffsetMinutes, undefined);
    }
    const east = parseCaptureDate("2026:01:01 00:15:00+08:00")!;
    assert.equal(east.dateTaken!.toISOString(), "2025-12-31T16:15:00.000Z");
    assert.equal(east.captureLocal, "2026-01-01T00:15:00.000");
    const west = parseCaptureDate("2025:12:31 23:45:00-08:00")!;
    assert.equal(west.dateTaken!.toISOString(), "2026-01-01T07:45:00.000Z");
    assert.equal(west.captureLocal.slice(0, 10), "2025-12-31");
    assert.equal(parseCaptureDate("2026:11:01 01:30:00-07:00")!.dateTaken!.toISOString(), "2026-11-01T08:30:00.000Z");
    assert.equal(parseCaptureDate("2026:11:01 01:30:00-08:00")!.dateTaken!.toISOString(), "2026-11-01T09:30:00.000Z");
}));

test("EXIF precedence, separate offset tags, fractions and explicit UTC", () => {
    const value = captureDateFromExif({ SubSecDateTimeOriginal: "2026:10:22 00:30:00.123456", DateTimeOriginal: "2025:01:01 00:00:00", OffsetTimeOriginal: "+08:00" })!;
    assert.equal(value.captureLocal, "2026-10-22T00:30:00.123");
    assert.equal(value.dateTaken!.toISOString(), "2026-10-21T16:30:00.123Z");
    assert.equal(parseCaptureDate("2026-01-01T12:00:00Z")!.captureOffsetMinutes, 0);
    assert.equal(parseCaptureDate("2026:01:01 12:00:00+0530")!.captureOffsetMinutes, 330);
    assert.equal(parseCaptureDate("2026:01:01 12:00:00-03:30")!.captureOffsetMinutes, -210);
    assert.equal(parseCaptureDate("2026:01:01 12:00:00Z", "+08:00")!.captureOffsetMinutes, 0);
    assert.equal(captureDateFromExif({ CreateDate: "2026:01:01 12:00:00" })!.dateTaken, undefined);
    assert.equal(captureDateFromExif({ CreateDate: "2026:01:01 12:00:00", OffsetTimeDigitized: "+08:00" })!.captureOffsetMinutes, 480);
});

test("missing and invalid camera dates never become import dates or silently roll forward", () => {
    for (const raw of ["0000:00:00 00:00:00", "2026:02:29 12:00:00", "2024:02:30 12:00:00", "2026:13:01 00:00:00", "2026:01:01 24:00:00", "2026:01:01 00:60:00", "2026:01:01 00:00:60", "2026:01:01 00:00:00+14:01", "2026:01:01 00:00:00+25:00", "not a date"]) assert.equal(parseCaptureDate(raw), undefined, raw);
    assert.ok(parseCaptureDate("2024:02:29 12:00:00"));
    assert.equal(captureDateFromExif({}), undefined);
    assert.equal(captureDateFromExif({ DateTimeOriginal: "bad", CreateDate: "2026:01:01 00:00:00" }), undefined);
    assert.equal(captureDateFromExif({ DateTimeOriginal: "2026:01:01 00:00:00", OffsetTimeOriginal: "invalid" }), undefined);
});

for (const zone of zones) test(`calendar display does not use browser/server timezone: ${zone}`, () => inZone(zone, () => {
    const naive = { date_taken: null, capture_local: "2026-01-01T00:15:00.000", capture_offset_minutes: null };
    assert.match(formatCaptureDate(naive), /1 Jan 2026, 00:15.*timezone unknown/);
    const explicit = { ...naive, date_taken: "2025-12-31T16:15:00.000Z", capture_offset_minutes: 480 };
    assert.match(formatCaptureDate(explicit), /1 Jan 2026, 00:15.*UTC\+08:00/);
    assert.match(formatCaptureDate({ date_taken: "2025-12-31T23:30:00.000Z" }), /31 Dec 2025, 23:30.*legacy UTC/);
    assert.equal(formatCaptureDate({ date_taken: null }), "Capture date unknown");
    assert.equal(captureCalendar({ date_taken: "invalid" }), undefined);
    assert.equal(captureCalendar({ date_taken: null, capture_local: "2026-01-01T00:00:00Z" }), undefined);
}));

for (const zone of zones) test(`year/month/day grouping, midnight and missing capture dates: ${zone}`, async () => {
    const { groupMediaByDate, getMediaDate } = await import("../lib/media-grouping");
    inZone(zone, () => {
        const explicit = { id: 1, date_taken: "2025-12-31T16:15:00.000Z", capture_local: "2026-01-01T00:15:00.000", capture_offset_minutes: 480,
            file_modified_at: "2026-06-01T00:00:00.000Z", date_imported: "2026-07-01T00:00:00.000Z" };
        const naive = { id: 2, date_taken: null, capture_local: "2026-01-01T00:30:00.000" };
        const missing = { id: 3, date_taken: null, date_imported: "2026-05-01T00:00:00.000Z" };
        const absent = { id: 4, date_taken: null };
        const invalid = { id: 5, date_taken: "invalid" };
        const legacy = { id: 6, date_taken: "2025-12-31T23:45:00.000Z" };
        const modified = { id: 7, date_taken: null, file_modified_at: "2026-01-01T00:30:00.000Z",
            file_modified_timezone: "America/Los_Angeles", date_imported: "2026-07-01T00:00:00.000Z" };
        const invalidModified = { id: 8, date_taken: "invalid", file_modified_at: "invalid", date_imported: missing.date_imported };
        const all = [explicit, naive, missing, absent, invalid, legacy, modified, invalidModified];
        assert.deepEqual(groupMediaByDate(all, "Years").map(([key]) => key), ["2026", "Date unknown", "2025"]);
        assert.deepEqual(groupMediaByDate(all, "Months").map(([key]) => key), ["January 2026", "May 2026", "Date unknown", "December 2025"]);
        assert.deepEqual(groupMediaByDate(all, "Days").map(([key, items]) => [key, items.map(item => item.id)]), [["1 January 2026", [1, 2]], ["1 May 2026", [3, 8]], ["Date unknown", [4, 5]], ["31 December 2025", [6, 7]]]);
        assert.deepEqual(groupMediaByDate(all, "All"), [["All", all]]);
        assert.equal(getMediaDate(explicit)?.toISOString(), explicit.capture_local + "Z");
        assert.equal(getMediaDate(modified)?.toISOString(), modified.file_modified_at);
        assert.equal(getMediaDate(missing)?.toISOString(), missing.date_imported);
        assert.equal(getMediaDate(invalidModified)?.toISOString(), missing.date_imported);
        assert.equal(getMediaDate(absent), undefined);
        assert.equal(getMediaDate(invalid), undefined);
    });
});


import assert from "node:assert/strict";
import { test } from "node:test";

import { publicMedia } from "./api-dto";
import { formatMediaDisplayDate } from "../lib/media-display-date";
import { groupMediaByDate } from "../lib/media-grouping";
import type { MediaDisplayDateFields } from "../lib/media-display-date";

test("saved file timezone survives the API and timeline grouping", () => {
    const media = publicMedia({
        media_id: 1,
        file_name: "new-year.jpg",
        file_type: "IMAGE",
        date_taken: null,
        file_modified_at: "2026-01-01T00:30:00.000Z",
        file_modified_timezone: "America/Los_Angeles",
        date_imported: "2026-01-02T00:00:00.000Z",
    });

    const dateFields: MediaDisplayDateFields = {
        date_taken: media.date_taken as string | null,
        capture_local: media.capture_local as string | null | undefined,
        capture_offset_minutes: media.capture_offset_minutes as number | null | undefined,
        file_modified_at: media.file_modified_at as string | null | undefined,
        file_modified_timezone: media.file_modified_timezone as string | null | undefined,
        date_imported: media.date_imported as string | null | undefined,
    };

    const display = formatMediaDisplayDate(dateFields);
    const groups = groupMediaByDate([dateFields], "Days");

    assert.match(display, /31 Dec 2025/);
    assert.equal(groups.length, 1);
    assert.match(groups[0][0], /31 December 2025/);
});

test("import date is used when other timestamps are unavailable", () => {
    const media = publicMedia({
        media_id: 2,
        file_name: "unknown-date.jpg",
        file_type: "IMAGE",
        date_taken: null,
        file_modified_at: null,
        file_modified_timezone: null,
        date_imported: "2026-03-12T10:00:00.000Z",
    });

    const dateFields: MediaDisplayDateFields = {
        date_taken: media.date_taken as string | null,
        capture_local: media.capture_local as string | null | undefined,
        capture_offset_minutes: media.capture_offset_minutes as number | null | undefined,
        file_modified_at: media.file_modified_at as string | null | undefined,
        file_modified_timezone: media.file_modified_timezone as string | null | undefined,
        date_imported: media.date_imported as string | null | undefined,
    };

    assert.match(
        formatMediaDisplayDate(dateFields),
        /Imported: 12 Mar 2026/
    );
    assert.match(
        groupMediaByDate([dateFields], "Days")[0][0],
        /12 March 2026/
    );
});

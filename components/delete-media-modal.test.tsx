
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
    cleanup,
    fireEvent,
    render,
    screen,
} from "@testing-library/react";

import { DeleteMediaModal } from "./delete-media-modal";
import { mockDialogMethods } from "./modal-test-utils";

const bulkState = vi.hoisted(() => ({
    busy: false,
}));

vi.mock("../lib/use-bulk-media", () => ({
    useBulkMedia: () => ({
        busy: bulkState.busy,
        items: [],
        canRun: () => true,
        run: vi.fn(),
    }),
}));

beforeEach(() => {
    bulkState.busy = false;
    mockDialogMethods();
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

test("Delete Media exposes an accessible dialog", async () => {
    render(
        <DeleteMediaModal
            open
            mediaIds={[1]}
            fileName="photo.jpg"
            onClose={vi.fn()}
            onDeleted={vi.fn()}
        />
    );

    const dialog = await screen.findByRole("dialog", {
        name: "Delete media?",
    });

    expect(dialog.getAttribute("aria-labelledby")).toBeTruthy();
    expect(dialog.hasAttribute("open")).toBe(true);

    expect(screen.getByText(/photo\.jpg/)).toBeTruthy();
});

test("Escape dismisses Delete Media when idle", () => {
    const onClose = vi.fn();

    render(
        <DeleteMediaModal
            open
            mediaIds={[1]}
            onClose={onClose}
            onDeleted={vi.fn()}
        />
    );

    fireEvent(
        screen.getByRole("dialog"),
        new Event("cancel", {
            bubbles: false,
            cancelable: true,
        })
    );

    expect(onClose).toHaveBeenCalledOnce();
});

test("Escape cannot dismiss Delete Media during deletion", () => {
    bulkState.busy = true;

    const onClose = vi.fn();

    render(
        <DeleteMediaModal
            open
            mediaIds={[1]}
            onClose={onClose}
            onDeleted={vi.fn()}
        />
    );

    fireEvent(
        screen.getByRole("dialog"),
        new Event("cancel", {
            bubbles: false,
            cancelable: true,
        })
    );

    expect(onClose).not.toHaveBeenCalled();

    expect(
        screen.getByRole("button", { name: "Cancel" })
    ).toHaveProperty("disabled", true);
});

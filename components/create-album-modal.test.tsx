
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";

import { CreateAlbumModal } from "./create-album-modal";
import { mockDialogMethods } from "./modal-test-utils";

beforeEach(() => {
    mockDialogMethods();
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

test("Create Album exposes an accessible dialog", async () => {
    render(
        <CreateAlbumModal
            open
            onClose={vi.fn()}
            onCreated={vi.fn()}
        />
    );

    const dialog = await screen.findByRole("dialog", {
        name: "Create album",
    });

    expect(dialog.getAttribute("aria-labelledby")).toBeTruthy();
    expect(dialog.hasAttribute("open")).toBe(true);

    expect(
        screen.getByRole("textbox", { name: "Album name" })
    ).toBeTruthy();
});

test("Escape closes Create Album and resets its input", async () => {
    const onClose = vi.fn();

    const { rerender } = render(
        <CreateAlbumModal
            open
            onClose={onClose}
            onCreated={vi.fn()}
        />
    );

    fireEvent.change(
        screen.getByRole("textbox", { name: "Album name" }),
        { target: { value: "My holiday" } }
    );

    fireEvent(
        screen.getByRole("dialog"),
        new Event("cancel", {
            bubbles: false,
            cancelable: true,
        })
    );

    expect(onClose).toHaveBeenCalledOnce();

    rerender(
        <CreateAlbumModal
            open={false}
            onClose={onClose}
            onCreated={vi.fn()}
        />
    );

    rerender(
        <CreateAlbumModal
            open
            onClose={onClose}
            onCreated={vi.fn()}
        />
    );

    await waitFor(() => {
        expect(
            (screen.getByRole("textbox", {
                name: "Album name",
            }) as HTMLInputElement).value
        ).toBe("");
    });
});

test("Create Album cannot be dismissed during submission", async () => {
    let resolveRequest!: (response: Response) => void;

    vi.stubGlobal(
        "fetch",
        vi.fn(() => new Promise<Response>(resolve => {
            resolveRequest = resolve;
        }))
    );

    const onClose = vi.fn();

    render(
        <CreateAlbumModal
            open
            onClose={onClose}
            onCreated={vi.fn()}
        />
    );

    fireEvent.change(
        screen.getByRole("textbox", { name: "Album name" }),
        { target: { value: "Holiday" } }
    );

    fireEvent.click(
        screen.getByRole("button", { name: "Create album" })
    );

    await waitFor(() => {
        expect(
            screen.getByRole("button", { name: "Creating..." })
        ).toHaveProperty("disabled", true);
    });

    fireEvent(
        screen.getByRole("dialog"),
        new Event("cancel", {
            bubbles: false,
            cancelable: true,
        })
    );

    expect(onClose).not.toHaveBeenCalled();

    resolveRequest(
        Response.json({ error: "Temporary failure" }, { status: 503 })
    );

    await screen.findByText("Temporary failure");
});


import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Viewer } from "./gallery";
import { mockDialogMethods } from "./modal-test-utils";

const router = vi.hoisted(() => ({
    back: vi.fn(),
    push: vi.fn(),
    replace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
    useRouter: () => router,
    useSearchParams: () => new URLSearchParams("scope=all"),
}));

vi.mock("next/image", () => ({
    default: () => <span data-testid="mock-image" />,
}));

vi.mock("./icons", () => ({
    Icon: ({ name }: { name: string }) => <span data-icon={name} />,
}));

const mediaA = {
    media_id: 1,
    file_name: "photo-A.jpg",
    file_type: "IMAGE",
    favorite: false,
    date_taken: null,
    file_size: 100,
    width: 100,
    height: 100,
};

const mediaB = {
    ...mediaA,
    media_id: 2,
    file_name: "photo-B.jpg",
};

function json(data: unknown) {
    return Response.json(data);
}

beforeEach(() => {
    mockDialogMethods();
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

test("viewer never deletes stale media during navigation", async () => {
    const deletedIds: number[] = [];

    let resolveB!: (response: Response) => void;

    const delayedB = new Promise<Response>(resolve => {
        resolveB = resolve;
    });

    const fetchMock = vi.fn(
        async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
            const url = String(input);

            if (url === "/api/media?scope=all") {
                return json([mediaA, mediaB]);
            }

            if (url === "/api/media/1") {
                if (init?.method === "DELETE") {
                    deletedIds.push(1);
                    return json({ message: "Media deleted" });
                }

                return json(mediaA);
            }

            if (url === "/api/media/2") {
                if (init?.method === "DELETE") {
                    deletedIds.push(2);
                    return json({ message: "Media deleted" });
                }

                return delayedB;
            }

            throw new Error(`Unexpected request: ${url}`);
        }
    );

    vi.stubGlobal("fetch", fetchMock);

    // jsdom does not implement element scrolling.
    vi.stubGlobal(
        "scrollTo",
        vi.fn()
    );

    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
        configurable: true,
        value: vi.fn(),
    });

    render(<Viewer id="1" />);

    // Image A must finish loading before navigation.
    await waitFor(() => {
        const button = screen.getByRole("button", {
            name: "Delete media",
        });

        expect((button as HTMLButtonElement).disabled).toBe(false);
    });

    // Navigate to B while its detail response is delayed.
    fireEvent.click(
        screen.getByRole("button", { name: "Next media" })
    );

    // A is still loaded internally, but B is selected.
    await waitFor(() => {
        const button = screen.getByRole("button", {
            name: "Delete media",
        });

        expect((button as HTMLButtonElement).disabled).toBe(true);
    });

    expect(
        screen.queryByRole("button", { name: "Delete permanently" })
    ).toBeNull();

    expect(deletedIds).toEqual([]);

    // Simulate B's delayed response arriving.
    await act(async () => {
        resolveB(json(mediaB));
    });

    await waitFor(() => {
        const button = screen.getByRole("button", {
            name: "Delete media",
        });

        expect((button as HTMLButtonElement).disabled).toBe(false);
    });

    // Open confirmation for the newly selected image.
    fireEvent.click(
        screen.getByRole("button", { name: "Delete media" })
    );

    expect(
        screen.getByText('Permanently delete "photo-B.jpg"?')
    ).toBeTruthy();

    // Simulate confirming deletion against the mocked API.
    fireEvent.click(
        screen.getByRole("button", { name: "Delete permanently" })
    );

    await waitFor(() => {
        expect(deletedIds).toEqual([2]);
    });

    expect(
        fetchMock.mock.calls.some(([url, options]) =>
            String(url) === "/api/media/1" &&
            options?.method === "DELETE"
        )
    ).toBe(false);
});

test("deletion confirmation retains its original target during navigation", async () => {
    const deletedIds: number[] = [];

    const fetchMock = vi.fn(async (
        input: RequestInfo | URL,
        init?: RequestInit
    ): Promise<Response> => {
        const url = String(input);

        if (url === "/api/media?scope=all") {
            return Response.json([mediaA, mediaB]);
        }

        if (url === "/api/media/1") {
            if (init?.method === "DELETE") {
                deletedIds.push(1);
                return Response.json({ message: "Media deleted" });
            }
            return Response.json(mediaA);
        }

        if (url === "/api/media/2") {
            if (init?.method === "DELETE") {
                deletedIds.push(2);
                return Response.json({ message: "Media deleted" });
            }
            return Response.json(mediaB);
        }

        throw new Error(`Unexpected request: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
        configurable: true,
        value: vi.fn(),
    });

    render(<Viewer id="1" />);

    await waitFor(() => {
        expect(
            (screen.getByRole("button", {
                name: "Delete media",
            }) as HTMLButtonElement).disabled
        ).toBe(false);
    });

    fireEvent.click(
        screen.getByRole("button", { name: "Delete media" })
    );

    expect(
        screen.getByText('Permanently delete "photo-A.jpg"?')
    ).toBeTruthy();

    // Simulate a selection change while the confirmation remains open.
    // Navigation is normally blocked by the modal, so this verifies
    // that even an unexpected navigation cannot change the target.
    fireEvent.click(
        screen.getByRole("button", { name: "Next media" })
    );

    expect(
        screen.getByText('Permanently delete "photo-A.jpg"?')
    ).toBeTruthy();

    fireEvent.click(
        screen.getByRole("button", { name: "Delete permanently" })
    );

    await waitFor(() => {
        expect(deletedIds).toEqual([1]);
    });

    expect(deletedIds).not.toContain(2);
});

test("a delayed favorite update cannot overwrite another image", async () => {
    let resolvePatch!: (response: Response) => void;

    const delayedPatch = new Promise<Response>(resolve => {
        resolvePatch = resolve;
    });

    const patchIds: number[] = [];

    const fetchMock = vi.fn(async (
        input: RequestInfo | URL,
        init?: RequestInit
    ): Promise<Response> => {
        const url = String(input);

        if (url === "/api/media?scope=all") {
            return Response.json([mediaA, mediaB]);
        }

        if (url === "/api/media/1") {
            if (init?.method === "PATCH") {
                patchIds.push(1);
                return delayedPatch;
            }
            return Response.json(mediaA);
        }

        if (url === "/api/media/2") {
            if (init?.method === "PATCH") {
                patchIds.push(2);
                return Response.json({
                    message: "Favorite changed successfully",
                    mediaId: 2,
                });
            }
            return Response.json({
                ...mediaB,
                favorite: false,
            });
        }

        throw new Error(`Unexpected request: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
        configurable: true,
        value: vi.fn(),
    });

    render(<Viewer id="1" />);

    await waitFor(() => {
        expect(
            (screen.getByRole("button", {
                name: "Toggle favorite",
            }) as HTMLButtonElement).disabled
        ).toBe(false);
    });

    // Start favoriting image A.
    fireEvent.click(
        screen.getByRole("button", {
            name: "Toggle favorite",
        })
    );

    await waitFor(() => {
        expect(patchIds).toEqual([1]);
    });

    // Navigate to B before A's PATCH completes.
    fireEvent.click(
        screen.getByRole("button", {
            name: "Next media",
        })
    );

    await waitFor(() => {
        const button = screen.getByRole("button", {
            name: "Toggle favorite",
        });

        expect(button.getAttribute("aria-pressed")).toBe("false");
        expect((button as HTMLButtonElement).disabled).toBe(false);
    });

    // A's request completes after B has loaded.
    await act(async () => {
        resolvePatch(Response.json({
            message: "Favorite changed successfully",
            mediaId: 1,
        }));
    });

    // B must remain unfavorited.
    expect(
        screen.getByRole("button", {
            name: "Toggle favorite",
        }).getAttribute("aria-pressed")
    ).toBe("false");

    expect(patchIds).toEqual([1]);
});

test("rapid favorite clicks do not submit duplicate requests", async () => {
    let resolvePatch!: (response: Response) => void;

    const delayedPatch = new Promise<Response>(resolve => {
        resolvePatch = resolve;
    });

    let patchCount = 0;

    vi.stubGlobal("fetch", vi.fn(async (
        input: RequestInfo | URL,
        init?: RequestInit
    ): Promise<Response> => {
        const url = String(input);

        if (url === "/api/media?scope=all") {
            return Response.json([mediaA, mediaB]);
        }

        if (url === "/api/media/1") {
            if (init?.method === "PATCH") {
                patchCount++;
                return delayedPatch;
            }

            return Response.json(mediaA);
        }

        throw new Error(`Unexpected request: ${url}`);
    }));

    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
        configurable: true,
        value: vi.fn(),
    });

    render(<Viewer id="1" />);

    await waitFor(() => {
        expect(
            (screen.getByRole("button", {
                name: "Toggle favorite",
            }) as HTMLButtonElement).disabled
        ).toBe(false);
    });

    const button = screen.getByRole("button", {
        name: "Toggle favorite",
    });

    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);

    expect(patchCount).toBe(1);

    await act(async () => {
        resolvePatch(Response.json({
            message: "Favorite changed successfully",
            mediaId: 1,
        }));
    });

    expect(
        screen.getByRole("button", {
            name: "Toggle favorite",
        }).getAttribute("aria-pressed")
    ).toBe("true");
});


test("failed favorite updates display an error and allow retry", async () => {
    let attempts = 0;

    vi.stubGlobal("fetch", vi.fn(async (
        input: RequestInfo | URL,
        init?: RequestInit
    ): Promise<Response> => {
        const url = String(input);

        if (url === "/api/media?scope=all") {
            return Response.json([mediaA, mediaB]);
        }

        if (url === "/api/media/1") {
            if (init?.method === "PATCH") {
                attempts++;

                if (attempts === 1) {
                    return Response.json(
                        { error: "Temporary failure" },
                        { status: 503 }
                    );
                }

                return Response.json({
                    message: "Favorite changed successfully",
                    mediaId: 1,
                });
            }

            return Response.json(mediaA);
        }

        throw new Error(`Unexpected request: ${url}`);
    }));

    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
        configurable: true,
        value: vi.fn(),
    });

    render(<Viewer id="1" />);

    const heart = () => screen.getByRole("button", {
        name: "Toggle favorite",
    });

    await waitFor(() => {
        expect((heart() as HTMLButtonElement).disabled).toBe(false);
    });

    fireEvent.click(heart());

    expect(
        await screen.findByRole("alert")
    ).toHaveProperty(
        "textContent",
        "Could not update favorite. Please try again."
    );

    expect(heart().getAttribute("aria-pressed")).toBe("false");

    await waitFor(() => {
        expect((heart() as HTMLButtonElement).disabled).toBe(false);
    });

    fireEvent.click(heart());

    await waitFor(() => {
        expect(heart().getAttribute("aria-pressed")).toBe("true");
    });

    expect(attempts).toBe(2);
});

export type BulkOutcome = "confirmed" | "failed" | "uncertain" | "pending" | "running";
export type BulkItem = {
    id: number;
    outcome: BulkOutcome;
    unchanged?: boolean;
    reason?: string;
};
export type BulkOperation = {
    kind:
        | "delete"
        | "album-add"
        | "album-remove"
        | "trip-add"
        | "trip-move"
        | "trip-remove";
    collectionId?: number;
};


export async function requestBulkItem(
    operation: BulkOperation,
    id: number
): Promise<BulkItem> {
    const { kind, collectionId } = operation;
    const isDelete = kind === "delete";
    const isTrip = kind.startsWith("trip-");
    const isAdd = kind === "album-add" || kind === "trip-add";
    const isMove = kind === "trip-move";

    const url = isDelete
        ? `/api/media/${id}`
        : `/api/${isTrip ? "trips" : "albums"}/${collectionId}/media`;

    try {
        const response = await fetch(url, isDelete
            ? { method: "DELETE" }
            : {
                method: isMove ? "PATCH" : isAdd ? "POST" : "DELETE",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ mediaId: id }),
            }
        );

        if (response.redirected) {
            return { id, outcome: "uncertain" };
        }

        // A known business-rule rejection: no mutation occurred.
        if (isMove && response.status === 409) {
            const body = await response.json().catch(() => null);

            if (body?.code === "ALREADY_IN_TRIP") {
                return {
                    id,
                    outcome: "failed",
                    reason: "Already in this Trip. Choose another Trip.",
                };
            }

            return {
                id,
                outcome: "failed",
                reason: "Trip membership changed. Review and retry.",
            };
        }

        if (!response.ok) {
            const knownFailure = [
                400, 401, 403, 404, 409, 413, 415, 422,
            ].includes(response.status);

            return {
                id,
                outcome: knownFailure ? "failed" : "uncertain",
                reason: knownFailure
                    ? response.status === 404
                        ? "Media or destination was not found."
                        : "Operation was rejected."
                    : undefined,
            };
        }

        const body = await response.json();

        if (isMove) {
            if (
                body?.message === "Media moved successfully" &&
                body?.movedCount === 1
            ) {
                return { id, outcome: "confirmed", unchanged: false };
            }

            if (
                body?.message === "Media already in trip" &&
                body?.movedCount === 0 &&
                body?.unchanged === true
            ) {
                return { id, outcome: "confirmed", unchanged: true };
            }

            return { id, outcome: "uncertain" };
        }

        if (isAdd) {
            if (body?.addedCount !== 0 && body?.addedCount !== 1) {
                return { id, outcome: "uncertain" };
            }

            if (kind === "trip-add" && body.addedCount !== 1) {
                return { id, outcome: "uncertain" };
            }

            return {
                id,
                outcome: "confirmed",
                unchanged: body.addedCount === 0,
            };
        }

        const expectedMessage = isDelete
            ? "Media deleted"
            : isTrip
                ? "Media removed from trip"
                : "Media removed from album";

        return body?.message === expectedMessage
            ? { id, outcome: "confirmed" }
            : { id, outcome: "uncertain" };
    } catch {
        return { id, outcome: "uncertain" };
    }
}

// One explicit per-item batch/retry session. It never splits transactional APIs.
export type BulkReviewStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function createBulkSession(scope = "", review?: BulkReviewStore) {
    const items = new Map<number, BulkItem>();
    let running = false;
    let active = true;
    const key = (id: number) => `gallery-bulk-review:v1:${scope}:${id}`;
    return {
        activate() { active = true; },
        isActive() { return active; },
        stop() { active = false; },
        available(id: number) { if (!running && items.get(id)?.outcome === "confirmed") items.delete(id); },
        canRun(ids: number[]) { return !running && ids.some(id => !["confirmed", "uncertain"].includes(items.get(id)?.outcome ?? "pending")); },
        snapshot() { return [...items.values()]; },
        async run(ids: number[], execute: (id: number) => Promise<BulkItem>, update: (items: BulkItem[]) => void, refresh: () => void) {
            if (running || !active) return;
            running = true;
            let attempted = false;
            try {
                for (const id of new Set(ids)) if (!items.has(id)) items.set(id, { id, outcome: review?.getItem(key(id)) ? "uncertain" : "pending" });
                if (active) update([...items.values()]);
                for (const id of new Set(ids)) {
                    if (!active) break;
                    if (["confirmed", "uncertain"].includes(items.get(id)!.outcome)) continue;
                    review?.setItem(key(id), "Unconfirmed operation; independently review before replay");
                    attempted = true;
                    items.set(id, { id, outcome: "running" });
                    if (active) update([...items.values()]);
                    // Do not abort an in-flight mutation on unmount: its response
                    // still determines the outcome. Stop scheduling subsequent IDs.
                    let item: BulkItem;
                    try { item = await execute(id); }
                    catch { item = { id, outcome: "uncertain" }; }
                    items.set(id, item);
                    if (item.outcome !== "uncertain") review?.removeItem(key(id));
                    if (active) update([...items.values()]);
                }
            } finally {
                running = false;
                if (attempted) refresh();
            }
        },
    };
}

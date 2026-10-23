export type BulkOutcome = "confirmed" | "failed" | "uncertain" | "pending" | "running";
export type BulkItem = { id: number; outcome: BulkOutcome; unchanged?: boolean };
export type BulkOperation = {
    kind:
        | "delete"
        | "album-add"
        | "album-remove"
        | "trip-add"
        | "trip-remove";
    collectionId?: number;
};


export async function requestBulkItem(
    operation: BulkOperation,
    id: number
): Promise<BulkItem> {
    const isDelete = operation.kind === "delete";
    const isTrip = operation.kind.startsWith("trip-");
    const isAdd = operation.kind.endsWith("-add");

    const url = isDelete
        ? `/api/media/${id}`
        : `/api/${isTrip ? "trips" : "albums"}/${operation.collectionId}/media`;

    try {
        const response = await fetch(
            url,
            isDelete
                ? { method: "DELETE" }
                : {
                    method: isAdd ? "POST" : "DELETE",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ mediaId: id }),
                }
        );

        if (response.redirected) {
            return { id, outcome: "uncertain" };
        }

        if (!response.ok) {
            return {
                id,
                outcome: [400, 401, 403, 404, 409, 413, 415, 422]
                    .includes(response.status)
                    ? "failed"
                    : "uncertain",
            };
        }

        const body = await response.json();

        if (isAdd) {
            if (body?.addedCount !== 0 && body?.addedCount !== 1) {
                return { id, outcome: "uncertain" };
            }

            // Trip assignment must actually change membership.
            // Album addition may legitimately be a no-op when already added.
            if (isTrip && body.addedCount !== 1) {
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

        return {
            id,
            outcome: body?.message === expectedMessage
                ? "confirmed"
                : "uncertain",
        };
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

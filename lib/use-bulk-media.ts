"use client";
import { useEffect, useMemo, useState } from "react";
import { createBulkSession, requestBulkItem, type BulkItem, type BulkOperation } from "./bulk-media";

// Tab-scoped uncertainty survives modal unmount/navigation and reload. Memory
// fallback preserves navigation safety when browser storage is unavailable.
const retained = new Map<string, string>();
const reviewStore = {
    getItem(key: string) { try { return window.sessionStorage.getItem(key) ?? retained.get(key) ?? null; } catch { return retained.get(key) ?? null; } },
    setItem(key: string, value: string) { retained.set(key, value); try { window.sessionStorage.setItem(key, value); } catch { /* memory fallback */ } },
    removeItem(key: string) { retained.delete(key); try { window.sessionStorage.removeItem(key); } catch { /* stale persisted markers remain conservatively blocked */ } },
};

export function useBulkMedia(kind: BulkOperation["kind"], collectionId?: number) {
    const session = useMemo(() => createBulkSession(`${kind}:${collectionId ?? ""}`, reviewStore), [kind, collectionId]);
    const [view, setView] = useState({ session, items: [] as BulkItem[], busy: false });
    useEffect(() => { session.activate(); return () => session.stop(); }, [session]);
    async function run(ids: number[], confirmed: (ids: number[]) => void) {
        if (!session.isActive() || !session.canRun(ids)) {return {allConfirmed: false, allUnchanged: false};}
        setView({ session, items: session.snapshot(), busy: true });
        try {
            await session.run(ids, id => requestBulkItem({ kind, collectionId }, id), items => {
                setView({ session, items, busy: true });
                confirmed(
                    items
                        .filter(item =>
                            item.outcome === "confirmed" &&
                            item.unchanged !== true
                        )
                        .map(item => item.id)
                );
            }, () => window.dispatchEvent(new Event("media-library-updated")));
            const results = session.snapshot();
            return {
                allConfirmed:
                    ids.length > 0 &&
                    ids.every(id =>
                        results.find(item => item.id === id)?.outcome === "confirmed"
                    ),

                allUnchanged:
                    ids.length > 0 &&
                    ids.every(id => {
                        const item = results.find(result => result.id === id);

                        return item?.outcome === "confirmed" &&
                            item.unchanged === true;
                    }),
            };

        } finally {
            if (session.isActive()) setView({ session, items: session.snapshot(), busy: false });
        }
    }
    return {
        items: view.session === session ? view.items : [],
        busy: view.session === session && view.busy,
        run, canRun: session.canRun, available: session.available,
    };
}

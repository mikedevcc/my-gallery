import fs from "node:fs/promises";
import { withDestinationLock } from "./destination-lock";
import { beginMediaReplacement, commitMediaReplacement, deleteStoredMedia, rollbackMediaReplacement } from "./media-storage";

// Callbacks keep PostgreSQL work inside the same destination ownership interval.
export async function replaceMediaAtDestination(options: {
    root: string;
    destination: string;
    stagedPath: string;
    revalidateMetadata: () => Promise<void>;
    updateMetadata: () => Promise<void>;
}): Promise<void> {
    await withDestinationLock(options.root, options.destination, async lock => {
        await options.revalidateMetadata();
        await lock.revalidate();
        // A missing original is not a new-import opportunity for REPLACE.
        await fs.access(lock.destination);
        const state = await beginMediaReplacement(options.stagedPath, lock.destination, lock);
        try {
            await lock.assertOwned();
            await options.updateMetadata();
        } catch (error) {
            // Preserve existing best-effort rollback, but do not claim PostgreSQL
            // rolled back: a lost COMMIT acknowledgement is unresolved in H4-A.
            await lock.assertOwned();
            await rollbackMediaReplacement(state, lock);
            throw error;
        }
        await lock.assertOwned();
        await commitMediaReplacement(state, lock);
        lock.markSafe();
    });
}

export async function deleteMediaAtDestination(options: {
    root: string;
    destination: string;
    revalidateMetadata: () => Promise<boolean>;
    deleteMetadata: (assertStorage: () => Promise<void>) => Promise<boolean>;
    afterDelete: () => Promise<void>;
}): Promise<boolean> {
    return withDestinationLock(options.root, options.destination, async lock => {
        if (!await options.revalidateMetadata()) return false;
        await lock.revalidate();
        lock.markUnresolved();
        await lock.assertOwned();
        if (!await options.deleteMetadata(() => lock.assertOwned())) {
            lock.markSafe();
            return false;
        }
        await deleteStoredMedia(lock.destination, lock);
        await options.afterDelete();
        lock.markSafe();
        return true;
    });
}


import { ProcessingError } from "./processing-limits";

const MAX_ACTIVE = 2;
const MAX_WAITING = 64;
const MAX_WAIT_MS = 30_000;

let active = 0;

type Waiter = {
    grant: () => void;
};

const waiting: Waiter[] = [];

function releaseSlot(): void {
    active--;

    const next = waiting.shift();

    if (next) {
        active++;
        next.grant();
    }
}

async function acquireSlot(
    signal?: AbortSignal
): Promise<() => void> {
    if (signal?.aborted) {
        throw new ProcessingError(
            "Thumbnail request cancelled",
            408
        );
    }

    if (active < MAX_ACTIVE) {
        active++;
        return releaseSlot;
    }

    if (waiting.length >= MAX_WAITING) {
        throw new ProcessingError(
            "Thumbnail queue is full",
            503
        );
    }

    return new Promise((resolve, reject) => {
        let settled = false;
        let timeout: ReturnType<typeof setTimeout> | null = null;


        const waiter: Waiter = {
            grant: () => {
                if (settled) return;

                settled = true;
                cleanup();
                resolve(releaseSlot);
            },
        };

        const cleanup = () => {
            if (timeout !== null) {
                clearTimeout(timeout);
            }

            signal?.removeEventListener("abort", abort);
        };

        const removeWaiter = () => {
            const index = waiting.indexOf(waiter);
            if (index !== -1) {
                waiting.splice(index, 1);
            }
        };

        const abort = () => {
            if (settled) return;

            settled = true;
            removeWaiter();
            cleanup();

            reject(new ProcessingError(
                "Thumbnail request cancelled",
                408
            ));
        };

        timeout = setTimeout(() => {
            if (settled) return;

            settled = true;
            removeWaiter();
            cleanup();

            reject(new ProcessingError(
                "Thumbnail queue timed out",
                504
            ));
        }, MAX_WAIT_MS);

        waiting.push(waiter);
        signal?.addEventListener("abort", abort, {
            once: true,
        });

        // Handle cancellation between the initial
        // signal check and listener registration.
        if (signal?.aborted) abort();
    });
}

export async function withThumbnailSlot<T>(
    signal: AbortSignal | undefined,
    work: () => Promise<T>
): Promise<T> {
    const release = await acquireSlot(signal);

    try {
        if (signal?.aborted) {
            throw new ProcessingError(
                "Thumbnail request cancelled",
                408
            );
        }

        return await work();
    } finally {
        release();
    }
}

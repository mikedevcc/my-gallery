
"use client";

import { useEffect, useState } from "react";
import { useBulkMedia } from "@/lib/use-bulk-media";
import { BulkMediaFeedback } from "./bulk-media-feedback";

type DestinationKind = "trip" | "album";

type Destination = {
    id: number;
    name: string;
};

type Props = {
    kind: DestinationKind;
    mediaIds: number[];
    onClose: () => void;
    onConfirmed: (ids: number[]) => void;
};

export function GalleryDestinationModal({
    kind,
    mediaIds,
    onClose,
    onConfirmed,
}: Props) {
    const [destinations, setDestinations] = useState<Destination[]>([]);
    const [targetId, setTargetId] = useState<number | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [attempted, setAttempted] = useState(false);
    const [allAlreadyPresent, setAllAlreadyPresent] = useState(false);

    const bulk = useBulkMedia(
        kind === "trip" ? "trip-move" : "album-add",
        targetId ?? undefined
    );

    useEffect(() => {
        const controller = new AbortController();

        async function loadDestinations() {
            try {
                const response = await fetch(
                    kind === "trip" ? "/api/trips" : "/api/albums",
                    { signal: controller.signal }
                );

                if (!response.ok) {
                    throw new Error("Failed to load destinations");
                }

                const result = await response.json();

                if (controller.signal.aborted) return;

                const mapped: Destination[] = kind === "trip"
                    ? result.map((trip: {
                        trip_id: number;
                        trip_name: string;
                    }) => ({
                        id: trip.trip_id,
                        name: trip.trip_name,
                    }))
                    : result.map((album: {
                        album_id: number;
                        album_name: string;
                    }) => ({
                        id: album.album_id,
                        name: album.album_name,
                    }));

                setDestinations(mapped);
            } catch (error) {
                if (!controller.signal.aborted) {
                    setError(
                        error instanceof Error
                            ? error.message
                            : "Failed to load destinations"
                    );
                }
            } finally {
                if (!controller.signal.aborted) {
                    setLoading(false);
                }
            }
        }

        void loadDestinations();

        return () => controller.abort();
    }, [kind]);

    async function handleSubmit() {
        if (targetId === null || bulk.busy || attempted) return;

        // Freeze the destination after starting. Changing it while
        // reviewing partial results would create a new bulk session.
        setAttempted(true);

        try {
            const result = await bulk.run(mediaIds, onConfirmed);

            if (result.allConfirmed) {
                if (result.allUnchanged) {
                    setAllAlreadyPresent(true);
                } else {
                    onClose();
                }
            }
        } catch (error) {
            setError(
                error instanceof Error
                    ? error.message
                    : "Unable to complete the operation"
            );
        }
    }

    const label = kind === "trip" ? "Trip" : "Album";

    const hasUncertainResults = bulk.items.some(
        item => item.outcome === "uncertain"
    );

    function chooseDestination(id: number) {
        if (bulk.busy || hasUncertainResults) {
            return;
        }

        if (targetId === id) {
            return;
        }

        setTargetId(id);
        setAttempted(false);
        setError(null);
        setAllAlreadyPresent(false);
    }

    return (
        <div className="delete-media-backdrop">
            <div
                className="delete-media-modal"
                role="dialog"
                aria-modal="true"
                aria-labelledby="gallery-destination-title"
            >
                <div className="delete-media-header">
                    <div>
                        <h2 id="gallery-destination-title">
                            {kind === "trip"
                                ? "Move to Trip"
                                : "Add to Album"}
                        </h2>
                        <p>
                            {mediaIds.length} selected
                            {mediaIds.length === 1 ? " item" : " items"}
                        </p>
                    </div>

                    <button
                        type="button"
                        onClick={onClose}
                        disabled={bulk.busy}
                        aria-label="Close"
                    >
                        ×
                    </button>
                </div>

                <div className="delete-media-content">
                    <div
                        className="gallery-destination-list"
                        role="group"
                        aria-label={`Choose a destination ${label.toLowerCase()}`}
                    >
                        {loading ? (
                            <p className="gallery-destination-message">
                                Loading {label.toLowerCase()}s...
                            </p>
                        ) : destinations.length === 0 ? (
                            <div className="gallery-destination-empty">
                                <p>No {label.toLowerCase()}s available</p>
                                <small>
                                    Create a {label.toLowerCase()} before
                                    assigning media.
                                </small>
                            </div>
                        ) : (
                            destinations.map(destination => (
                                <button
                                    key={destination.id}
                                    type="button"
                                    className={`gallery-destination-option ${
                                        targetId === destination.id
                                            ? "selected"
                                            : ""
                                    }`}
                                    aria-pressed={targetId === destination.id}
                                    disabled={bulk.busy || hasUncertainResults}
                                    onClick={() => chooseDestination(destination.id)}
                                >
                                    <span>{destination.name}</span>

                                    {targetId === destination.id && (
                                        <span
                                            className="gallery-destination-check"
                                            aria-hidden="true"
                                        >
                                            ✓
                                        </span>
                                    )}
                                </button>
                            ))
                        )}
                    </div>

                    {allAlreadyPresent && (
                        <p className="gallery-destination-note" role="status">
                            {kind === "trip"
                                ? "All selected items are already in this Trip. Choose another Trip to move them."
                                : "All selected items are already in this Album. Choose another Album to add them."}
                        </p>
                    )}

                    {!loading && destinations.length === 0 && !error && (
                        <p>No {label.toLowerCase()}s available.</p>
                    )}

                    {error && <p role="alert">{error}</p>}

                    <BulkMediaFeedback items={bulk.items} />

                    {attempted && !bulk.busy && hasUncertainResults && (
                        <p role="alert">
                            Some operations could not be confirmed.
                            Check the current Trip membership before trying again.
                        </p>
                    )}

                    {attempted && !bulk.busy &&
                        !hasUncertainResults &&
                        bulk.items.some(item => item.outcome === "failed") && (
                            <p>
                                You can select another destination above.
                                Successfully processed media will not be repeated.
                            </p>
                        )}
                </div>

                <div className="delete-media-footer">
                    <button
                        type="button"
                        onClick={onClose}
                        disabled={bulk.busy}
                    >
                        Close
                    </button>

                    <button
                        type="button"
                        disabled={
                            loading ||
                            targetId === null ||
                            bulk.busy ||
                            attempted ||
                            !bulk.canRun(mediaIds)
                        }
                        onClick={() => void handleSubmit()}
                    >
                        {bulk.busy
                            ? "Processing..."
                            : kind === "trip"
                                ? "Move to Trip"
                                : "Add to Album"}
                    </button>
                </div>
            </div>
        </div>
    );
}

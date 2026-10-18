'use client';

import { useState } from 'react';

type CreateTripModalProps = {
    open: boolean;
    onClose: () => void;
    onCreated: () => void;
};

export function CreateTripModal({
    open,
    onClose,
    onCreated,
}: CreateTripModalProps) {
    const [tripName, setTripName] =
        useState('');

    const [creating, setCreating] =
        useState(false);

    const [error, setError] =
        useState<string | null>(null);

    if (!open) {
        return null;
    }

    async function createTrip() {
        const trimmedName = tripName.trim();

        if (trimmedName.length === 0) {
            setError('Trip name cannot be empty.');
            return;
        }

        setCreating(true);
        setError(null);

        try {
            const response =
                await fetch('/api/trips', {
                    method: 'POST',
                    headers: {
                        'Content-Type':
                            'application/json',
                    },
                    body: JSON.stringify({
                        tripName:
                            trimmedName,
                    }),
                });

            if (!response.ok) {
                const result =
                    await response.json() as {
                        error?: string;
                    };

                throw new Error(
                    result.error ??
                    `Failed to create trip (${response.status})`
                );
            }

            setTripName('');

            onCreated();
            onClose();
        }
        catch (error) {
            setError(
                error instanceof Error
                    ? error.message
                    : 'Failed to create trip'
            );
        }
        finally {
            setCreating(false);
        }
    }

    return (
        <div className="create-trip-backdrop">
            <div className="create-trip-modal">

                <div className="create-trip-header">
                    <div>
                        <h2>Create trip</h2>

                        <p>
                            Create a new collection
                            for your media.
                        </p>
                    </div>

                    <button
                        type="button"
                        onClick={onClose}
                        aria-label="Close"
                        disabled={creating}
                    >
                        ×
                    </button>
                </div>

                <div className="create-trip-content">

                    <label htmlFor="trip-name">
                        Trip name
                    </label>

                    <input
                        id="trip-name"
                        type="text"
                        value={tripName}
                        onChange={event =>
                            setTripName(
                                event.target.value
                            )
                        }
                        placeholder="e.g. Japan 2027"
                        maxLength={100}
                        autoFocus
                    />

                    {error && (
                        <p className="error">
                            {error}
                        </p>
                    )}

                </div>

                <div className="create-trip-footer">

                    <button
                        type="button"
                        onClick={onClose}
                        disabled={creating}
                    >
                        Cancel
                    </button>

                    <button
                        type="button"
                        onClick={() => {
                            void createTrip();
                        }}
                        disabled={
                            creating ||
                            tripName.trim().length === 0
                        }
                    >
                        {creating
                            ? 'Creating...'
                            : 'Create trip'}
                    </button>

                </div>

            </div>
        </div>
    );
}

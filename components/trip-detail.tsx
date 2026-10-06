'use client';

import { useEffect, useState } from 'react';

import { Icon } from './icons';


type TripRow = {
    trip_id: number;
    trip_name: string;
};

type TripMediaRow = {
    media_id: number;
    file_name: string;
    file_type: 'IMAGE' | 'VIDEO';
    path: string;
    date_taken: string | null;
    width: number | null;
    height: number | null;
    favorite: boolean;
};

type TripResponse = {
    trip: TripRow;
    media: TripMediaRow[];
};


export function TripDetail({
    slug,
}: {
    slug: string;
}) {
    const [data, setData] = useState<TripResponse | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const [tab, setTab] = useState('Overview');


    useEffect(() => {
        async function loadTrip() {
            try {
                const response = await fetch(
                    `/api/trips/${slug}`
                );

                if (!response.ok) {
                    throw new Error(
                        `Failed to load trip (${response.status})`
                    );
                }

                const result =
                    await response.json() as TripResponse;

                setData(result);
            }
            catch (error) {
                setError(
                    error instanceof Error
                        ? error.message
                        : 'Failed to load trip'
                );
            }
            finally {
                setLoading(false);
            }
        }

        void loadTrip();
    }, [slug]);


    if (loading) {
        return (
            <div className="empty-state">
                <h2>Loading trip...</h2>
            </div>
        );
    }


    if (error || !data) {
        return (
            <div className="empty-state">
                <h2>Unable to load trip</h2>
                <p>{error ?? 'Trip not found'}</p>
            </div>
        );
    }


    const {
        trip,
        media,
    } = data;


    return (
        <>
            <div className="trip-hero">
                <div className="trip-hero-shade"/>

                <div className="trip-hero-content">
                    <div className="hero-eyebrow">
                        <Icon
                            name="places"
                            size={16}
                        />

                        A COLLECTION OF MOMENTS
                    </div>

                    <h1>
                        {trip.trip_name}
                    </h1>

                    <div className="hero-meta">
                        <span>
                            <Icon
                                name="photos"
                                size={16}
                            />

                            {media.length.toLocaleString()}{' '}
                            {media.length === 1
                                ? 'photo'
                                : 'photos'}
                        </span>
                    </div>
                </div>
            </div>


            <div className="detail-tabs">
                {[
                    'Overview',
                    'Timeline',
                    'Photos',
                ].map(item => (
                    <button
                        key={item}
                        className={
                            tab === item
                                ? 'active'
                                : ''
                        }
                        onClick={() => setTab(item)}
                    >
                        {item}
                    </button>
                ))}
            </div>


            <div className="section-heading detail-section">
                <div>
                    <h2>
                        {tab === 'Photos'
                            ? 'All photos'
                            : tab === 'Timeline'
                                ? 'Moments along the way'
                                : 'The story so far'}
                    </h2>

                    <p>
                        {media.length === 0
                            ? 'No media has been added to this trip yet.'
                            : `${media.length} ${
                                media.length === 1
                                    ? 'memory'
                                    : 'memories'
                            } in this trip`}
                    </p>
                </div>
            </div>


            {media.length === 0 ? (
                <div className="empty-state">
                    <Icon
                        name="photos"
                        size={36}
                    />

                    <h2>No photos yet</h2>

                    <p>
                        Add photos to this trip to see them here.
                    </p>
                </div>
            ) : (
                <div className="trip-media-debug">
                    {media.map(item => (
                        <div
                            key={item.media_id}
                            className="trip-media-debug-item"
                        >
                            <strong>
                                {item.file_name}
                            </strong>

                            <span>
                                {item.file_type}
                            </span>

                            {item.date_taken && (
                                <span>
                                    {new Date(
                                        item.date_taken
                                    ).toLocaleDateString()}
                                </span>
                            )}
                        </div>
                    ))}
                </div>
            )}
        </>
    );
}
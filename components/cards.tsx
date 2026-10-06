import Image from 'next/image';
import Link from 'next/link';
import type {Album, TripCard} from '@/lib/types';
import {Icon} from './icons';
export function TripGrid({items}:{items:TripCard[]}) {
    return (
        <div className="card-grid trip-grid">
            {items.map(trip => (
                <Link
                    className="collection-card trip-card"
                    href={`/trips/${trip.slug}`}
                    key={trip.id}
                >
                    <div className="card-image">
                        {trip.cover && (
                            <Image
                                src={trip.cover}
                                alt={trip.name}
                                fill
                                sizes="(max-width: 700px) 100vw, 33vw"
                                unoptimized
                            />
                        )}

                        <div className="trip-shade">
                            {trip.places && (
                                <span className="trip-kicker">
                                    <Icon name="places" size={16}/>
                                    {trip.places}
                                </span>
                            )}

                            <h2>{trip.name}</h2>

                            <span className="trip-overlay-meta">
                                {trip.dates ?? "No dates yet"}
                                <span className="meta-dot"/>
                                {trip.count.toLocaleString()} photos
                            </span>
                        </div>
                    </div>
                </Link>
            ))}
        </div>
    );
}
export function AlbumGrid({items}:{items:Album[]}){return <div className="card-grid album-grid">{items.map(album=><Link className="collection-card" href={album.slug==='favorites'?'/favorites':album.slug==='videos'?'/videos':`/search?q=${encodeURIComponent(album.name)}`} key={album.slug}><div className="card-image"><Image src={album.cover} alt={album.name} fill sizes="(max-width: 700px) 50vw, 25vw" unoptimized/></div><div className="card-body"><h2>{album.name}</h2><p>{album.count.toLocaleString()} {album.name==='Videos'?'items':'photos'}</p></div></Link>)}</div>}

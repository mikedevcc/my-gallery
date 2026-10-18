'use client';

import {
    useEffect,
    useState,
} from 'react';
import {useSearchParams} from 'next/navigation';
import type {Photo,TripCard} from '@/lib/types';
import {albums,photos,trips} from '@/lib/mock-data';
import {PhotoGrid} from './gallery';
import {TripGrid,AlbumGrid} from './cards';
import {Icon} from './icons';
import { CreateTripModal } from './create-trip-modal';


type TripApiRow = {
    trip_id: number;
    trip_name: string;
    media_count: number;
    cover_media_id: number | null;
};


export function PhotosPage(){const [group,setGroup]=useState('Months');const [density,setDensity]=useState('comfortable');const sections:[string,string,Photo[]][]=group==='Months'?[['September 2026','Kyoto, Japan · 142 photos',photos.slice(0,6)],['August 2026','From Tokyo to the coast · 318 photos',photos.slice(6,14)],['July 2026','Little moments · 96 photos',photos.slice(14)]]:group==='Years'?[['2026','A year in photographs · 1,482 photos',photos]]:[['18 September 2026','Kyoto, Japan',photos.slice(0,4)],['17 September 2026','Kyoto, Japan',photos.slice(4,8)],['16 September 2026','Japan and beyond',photos.slice(8)]];return <><div className="eyebrow"><Icon name="sparkle" size={15}/> YOUR LIBRARY <span className="eyebrow-line"/></div><div className="page-heading home-heading"><div><h1>Photos</h1><p>Your memories, one moment at a time.</p></div><span className="photo-total">{photos.length.toLocaleString()} memories</span></div><div className="timeline-controls"><div className="segmented" aria-label="Group photos by">{['Years','Months','Days'].map(v=><button key={v} onClick={()=>setGroup(v)} className={group===v?'selected':''}>{v}</button>)}</div><div className="density-controls"><span>View</span><button className={density==='comfortable'?'selected':''} onClick={()=>setDensity('comfortable')} aria-label="Comfortable grid"><Icon name="grid" size={17}/></button><button className={density==='compact'?'selected':''} onClick={()=>setDensity('compact')} aria-label="Compact grid"><Icon name="sliders" size={17}/></button></div></div>{sections.map(([title,subtitle,items])=><section className="timeline-section" key={title}><div className="section-heading"><div><h2>{title}</h2><p>{subtitle}</p></div><button aria-label={`More options for ${title}`}><Icon name="more" size={20}/></button></div><PhotoGrid items={[...items]} density={density}/></section>)}</>}
export function TripsPage() {
    const [trips, setTrips] = useState<TripApiRow[]>([]);

    const [loading, setLoading] = useState(true);

    const [createTripOpen, setCreateTripOpen] = useState(false);


    async function loadTrips() {
        try {
            const response = await fetch('/api/trips');

            if (!response.ok) {
                throw new Error(
                    'Failed to load trips'
                );
            }

            const data = await response.json() as TripApiRow[];

            setTrips(data);
        }
        catch (error) {
            console.error(
                'Failed to load trips:',
                error
            );
        }
        finally {
            setLoading(false);
        }
    }


    useEffect(() => {
        async function initialLoad() {
            await loadTrips();
        }

        void initialLoad();
    }, []);


    const tripCards: TripCard[] =
        trips.map(trip => ({
            id: trip.trip_id,
            slug: String(trip.trip_id),
            name: trip.trip_name,
            count: trip.media_count,
            cover:
                trip.cover_media_id !== null
                    ? `/api/media/${trip.cover_media_id}/thumbnail`
                    : undefined,
        }));


    if (loading) {
        return <p>Loading trips...</p>;
    }


    return (
        <>
            <PageHeading
                eyebrow="THE JOURNEY"
                title="Trips"
                subtitle="Your journeys, beautifully organized"
                action="New Trip"
                onAction={() => {
                    setCreateTripOpen(true);
                }}
            />

            <TripGrid items={tripCards}/>

            <CreateTripModal
                open={createTripOpen}
                onClose={() => {
                    setCreateTripOpen(false);
                }}
                onCreated={() => {
                    void loadTrips();
                }}
            />
        </>
    );
}
export function AlbumsPage(){return <><PageHeading eyebrow="CURATED MOMENTS" title="Albums" subtitle="My collections" action="New Album"/><AlbumGrid items={albums}/></>}
export function FavoritesPage(){return <><PageHeading eyebrow="CLOSE TO HEART" title="Favorites" subtitle="The moments you love most"/><PhotoGrid items={photos.filter(p=>p.favorite)}/></>}
export function SearchPage(){const params=useSearchParams();const initial=params.get('q')||'';const [query,setQuery]=useState(initial);const [filter,setFilter]=useState('All');const q=query.toLowerCase().trim();const result=photos.filter(p=>!q||[p.title,p.location?.city,p.location?.country,...p.tags,p.camera?.model].some(s=>s?.toLowerCase().includes(q)));return <><PageHeading eyebrow="DISCOVER" title="Search" subtitle="Find any trip, moment, or memory"/><div className="search-hero"><Icon name="search" size={24}/><input aria-label="Search library" autoFocus value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search photos, trips, or anything..."/><span>↵</span></div><div className="filter-row">{['All','Photos','Trips','Albums','Videos'].map(f=><button key={f} className={filter===f?'active':''} onClick={()=>setFilter(f)}>{f}</button>)}</div>{!q&&<div className="suggestions"><span>TRY SEARCHING FOR</span>{['Kyoto temples','Singapore','Sony A7 III','Nature','Iceland'].map(s=><button key={s} onClick={()=>setQuery(s)}><Icon name="search" size={14}/>{s}</button>)}</div>}<div className="results-heading"><h2>{q?`Results for “${query}”`:'Explore your library'}</h2><span>{filter==='All'||filter==='Photos'?result.length:filter==='Trips'?trips.length:filter==='Albums'?albums.length:0} results</span></div>{filter==='Trips'?<TripGrid items={trips.filter(t=>!q||t.name.toLowerCase().includes(q)||t.places.toLowerCase().includes(q))}/>:filter==='Albums'?<AlbumGrid items={albums.filter(a=>!q||a.name.toLowerCase().includes(q))}/>:filter==='Videos'?<EmptyState title="No videos yet" text="Videos will appear here when your library is connected."/>:result.length?<PhotoGrid items={result}/>:<EmptyState title="No matches found" text="Try another trip, subject, or camera name."/>}</>}
export function SimplePage({kind}:{kind:'Recently Added'|'Videos'|'Screenshots'|'Trash'}){const items=kind==='Recently Added'?photos.slice(0,8):[];return <><PageHeading eyebrow="YOUR LIBRARY" title={kind} subtitle={kind==='Recently Added'?'The newest moments in your library':`${kind} in your library`}/>{items.length?<PhotoGrid items={items}/>:<EmptyState title={`No ${kind.toLowerCase()} yet`} text="Your collection will appear here when your library is connected."/>}</>}
function PageHeading({
    eyebrow,
    title,
    subtitle,
    action,
    onAction,
}:{
    eyebrow: string;
    title: string;
    subtitle: string;
    action?: string;
    onAction?: () => void;
}) {
    return (
        <>
            <div className="eyebrow">
                <Icon name="sparkle" size={15}/>
                {eyebrow}
                <span className="eyebrow-line"/>
            </div>

            <div className="page-heading">
                <div>
                    <h1>{title}</h1>
                    <p>{subtitle}</p>
                </div>

                {action && (
                    <button
                        className="outline-action"
                        onClick={onAction}
                    >
                        <Icon name="plus" size={17}/>
                        {action}
                    </button>
                )}
            </div>
        </>
    );
}
function EmptyState({title,text}:{title:string;text:string}){return <div className="empty-state"><Icon name="photos" size={36}/><h2>{title}</h2><p>{text}</p></div>}

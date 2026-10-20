import { TripDetail } from '@/components/trip-detail';


type TripPageProps = {
    params: Promise<{
        tripId:string
    }>
}


export default async function Page({
    params
}: TripPageProps) {
    const {tripId}=await params;
    
    return <TripDetail tripId={tripId}/>
}

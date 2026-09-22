import {TripDetail} from '@/components/trip-detail';
export default async function Page({params}:{params:Promise<{slug:string}>}){const {slug}=await params;return <TripDetail slug={slug}/>}

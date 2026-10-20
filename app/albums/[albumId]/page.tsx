import { AlbumDetail } from '@/components/album-detail';


type AlbumPageProps = {
    params: Promise<{
        albumId: string;
    }>;
};


export default async function AlbumPage({
    params,
}: AlbumPageProps) {
    const {
        albumId,
    } = await params;

    return (
        <AlbumDetail
            albumId={albumId}
        />
    );
}
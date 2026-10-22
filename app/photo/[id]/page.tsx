import { notFound } from "next/navigation";
import { Viewer } from '@/components/gallery';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    // Demo slugs must never be coerced into a live PostgreSQL media ID.
    if (!/^[1-9]\d*$/.test(id) || Number(id) > 2147483647) notFound();
    return <Viewer id={id} />;
}

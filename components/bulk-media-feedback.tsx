import type { BulkItem } from "../lib/bulk-media";

export function BulkMediaFeedback({ items }: { items: BulkItem[] }) {
    if (!items.length) return null;
    const confirmed = items.filter(item => item.outcome === "confirmed");
    const unchanged = confirmed.filter(item => item.unchanged).length;
    const failed = items.filter(item => item.outcome === "failed");
    const uncertain = items.filter(item => item.outcome === "uncertain");
    const running = items.filter(item => item.outcome === "running");
    const pending = items.filter(item => item.outcome === "pending");
    return <div role="status" aria-live="polite" className="bulk-media-feedback">
        <p>{confirmed.length} confirmed successful{unchanged ? ` (${unchanged} already in Album, ${confirmed.length - unchanged} newly added)` : ""}; {failed.length} failed; {uncertain.length} uncertain; {pending.length} not attempted; {running.length} processing.</p>
        {failed.length > 0 && <p>Rejected IDs: {failed.map(item => item.id).join(", ")}. Review the selection and retry rejected items only after resolving the cause.</p>}
        {uncertain.length > 0 && <p>Uncertain IDs: {uncertain.map(item => item.id).join(", ")}. These may already have completed and are blocked from retry. Check the refreshed library; deletion recovery may require administrator review.</p>}
    </div>;
}

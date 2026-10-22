
import type { BulkItem } from "../lib/bulk-media";

type BulkMediaFeedbackProps = {
    items: BulkItem[];
    fileNames?: Record<number, string>;
};

export function BulkMediaFeedback({
    items,
    fileNames = {},
}: BulkMediaFeedbackProps) {
    const failed = items.filter(
        item => item.outcome === "failed"
    );

    const uncertain = items.filter(
        item => item.outcome === "uncertain"
    );

    // No issues = no feedback.
    if (failed.length === 0 && uncertain.length === 0) {
        return null;
    }

    function getFileName(id: number) {
        return fileNames[id] ?? `Media #${id}`;
    }

    return (
        <div
            className="bulk-media-feedback"
            role="alert"
        >
            {failed.length > 0 && (
                <div className="bulk-feedback-error">
                    <p>
                        {failed.length} media{" "}
                        {failed.length === 1
                            ? "item failed"
                            : "items failed"}
                        . Please review and retry.
                    </p>

                    <ul>
                        {failed.map(item => (
                            <li key={`failed-${item.id}`}>
                                {getFileName(item.id)}
                            </li>
                        ))}
                    </ul>
                </div>
            )}

            {uncertain.length > 0 && (
                <div className="bulk-feedback-warning">
                    <p>
                        {uncertain.length}{" "}
                        {uncertain.length === 1
                            ? "operation has"
                            : "operations have"}{" "}
                        an uncertain result.
                        Do not retry until verified.
                    </p>

                    <ul>
                        {uncertain.map(item => (
                            <li key={`uncertain-${item.id}`}>
                                {getFileName(item.id)}
                            </li>
                        ))}
                    </ul>
                </div>
            )}
        </div>
    );
}

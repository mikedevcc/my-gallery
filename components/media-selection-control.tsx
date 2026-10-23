
type MediaSelectionControlProps = {
    selected: boolean;
    mediaName: string;
    onToggle: () => void;
};

export function MediaSelectionControl({
    selected,
    mediaName,
    onToggle,
}: MediaSelectionControlProps) {
    return (
        <button
            type="button"
            className="media-select"
            aria-label={`${selected ? 'Deselect' : 'Select'} ${mediaName}`}
            aria-pressed={selected}
            onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onToggle();
            }}
        >
            {selected ? '✓' : ''}
        </button>
    );
}

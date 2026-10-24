
'use client';

import { useEffect, useRef } from 'react';

export function useModalDialog(
    open: boolean,
    busy: boolean,
    onClose: () => void
) {
    const dialogRef = useRef<HTMLDialogElement>(null);
    const onCloseRef = useRef(onClose);
    const busyRef = useRef(busy);

    useEffect(() => {
        onCloseRef.current = onClose;
        busyRef.current = busy;
    });

    useEffect(() => {
        const dialog = dialogRef.current;
        if (!dialog || !open) return;

        const previouslyFocused = document.activeElement;

        dialog.showModal();

        return () => {
            if (dialog.open) dialog.close();

            if (
                previouslyFocused instanceof HTMLElement &&
                previouslyFocused.isConnected
            ) {
                previouslyFocused.focus();
            }
        };
    }, [open]);

    function handleCancel(event: React.SyntheticEvent<HTMLDialogElement>) {
        event.preventDefault();

        if (!busyRef.current) {
            onCloseRef.current();
        }
    }

    return { dialogRef, handleCancel };
}

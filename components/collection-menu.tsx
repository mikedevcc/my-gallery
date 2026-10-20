'use client';

import { useState } from 'react';

type CollectionMenuProps = {
    type: 'trip' | 'album';
    name: string;
    onRename: (name: string) => Promise<void>;
    onDelete: () => Promise<void>;
};

export function CollectionMenu({
    type,
    name,
    onRename,
    onDelete,
}: CollectionMenuProps) {
    const [open, setOpen] = useState(false);

    const [editing, setEditing] = useState(false);

    const [editedName, setEditedName] =
        useState(name);


    async function saveName() {
        const trimmedName = editedName.trim();

        if (!trimmedName) {
            return;
        }

        await onRename(trimmedName);

        setEditing(false);
    }


    function cancelEditing() {
        setEditedName(name);
        setEditing(false);
    }


    return (
        <div className="collection-menu">

            <button
                type="button"
                className="collection-menu-button"
                onClick={() => {
                    setOpen(current => !current);
                }}
                aria-label="Collection options"
            >
                ⋯
            </button>


            {open && (
                <div className="collection-menu-dropdown">

                    <button
                        type="button"
                        onClick={() => {
                            setEditedName(name);
                            setEditing(true);
                            setOpen(false);
                        }}
                    >
                        Edit name
                    </button>

                    <button
                        type="button"
                        className="danger"
                        onClick={() => {
                            void onDelete();
                            setOpen(false);
                        }}
                    >
                        Delete {type}
                    </button>

                </div>
            )}


            {editing && (
                <form
                    className="collection-edit-name"
                    onSubmit={(event) => {
                        event.preventDefault();
                        void saveName();
                    }}
                >
                    <input
                        type="text"
                        value={editedName}
                        onChange={(event) => {
                            setEditedName(event.target.value);
                        }}
                        maxLength={100}
                        autoFocus
                    />

                    <div className="collection-edit-actions">
                        <button
                            type="button"
                            onClick={cancelEditing}
                        >
                            Cancel
                        </button>

                        <button
                            type="submit"
                        >
                            Save
                        </button>
                    </div>
                </form>
            )}

        </div>
    );
}

import { vi } from "vitest";

export function mockDialogMethods() {
    Object.defineProperty(
        HTMLDialogElement.prototype,
        "showModal",
        {
            configurable: true,
            value: vi.fn(function (
                this: HTMLDialogElement
            ) {
                this.setAttribute("open", "");
            }),
        }
    );

    Object.defineProperty(
        HTMLDialogElement.prototype,
        "close",
        {
            configurable: true,
            value: vi.fn(function (
                this: HTMLDialogElement
            ) {
                this.removeAttribute("open");
            }),
        }
    );
}

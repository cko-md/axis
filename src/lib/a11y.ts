import type { KeyboardEvent } from "react";

/**
 * Keyboard activation for elements given button semantics via
 * `role="button"` + `tabIndex={0}`. Add as `onKeyDown={activateOnEnterSpace}`
 * so Enter/Space activate the element the same way a click does — without
 * duplicating the element's existing onClick handler.
 *
 * Enter/Space are dispatched as a synthetic click on the element, which fires
 * its existing React onClick. Space is prevented from scrolling the page.
 */
export function activateOnEnterSpace(e: KeyboardEvent<HTMLElement>): void {
  if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
    e.preventDefault();
    e.currentTarget.click();
  }
}

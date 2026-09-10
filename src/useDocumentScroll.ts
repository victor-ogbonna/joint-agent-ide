import { useEffect } from "react";

/**
 * Opt a document-style route (homepage, waitlist, privacy) into normal page
 * scrolling.
 *
 * The global base style locks html/body/#root to the viewport with
 * `overflow: hidden` because the IDE needs a fixed shell. Long marketing pages
 * do not, and under that rule the page cannot scroll natively — only an inner
 * container can, which behaves inconsistently across wheel, touch and keyboard.
 *
 * Removes the class on unmount so navigating into the IDE restores the locked
 * shell.
 */
export function useDocumentScroll() {
  useEffect(() => {
    document.documentElement.classList.add("doc-scroll");
    return () => document.documentElement.classList.remove("doc-scroll");
  }, []);
}

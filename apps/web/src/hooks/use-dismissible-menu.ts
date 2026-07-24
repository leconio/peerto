import type {
  Dispatch,
  RefObject,
  SetStateAction,
} from "react";
import { useEffect } from "react";

export function useDismissibleMenu(
  open: boolean,
  containerRef: RefObject<HTMLElement | null>,
  setOpen: Dispatch<SetStateAction<boolean>>,
): void {
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !containerRef.current?.contains(event.target)
      ) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [containerRef, open, setOpen]);
}

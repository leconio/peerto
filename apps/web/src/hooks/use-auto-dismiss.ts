import type {
  Dispatch,
  SetStateAction,
} from "react";
import { useEffect } from "react";

export function useAutoDismiss<T>(
  value: T | undefined,
  setValue: Dispatch<SetStateAction<T | undefined>>,
  delayMs: number,
): void {
  useEffect(() => {
    if (!value) return;
    const timer = window.setTimeout(() => setValue(undefined), delayMs);
    return () => window.clearTimeout(timer);
  }, [delayMs, setValue, value]);
}

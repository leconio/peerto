import { useEffect, useState } from "react";
import type { StoredFile } from "../../store";
import {
  isImageFile,
  isVideoFile,
  readStoredResourceFile,
} from "./resource-access";

export function useResourceObjectUrl(
  file?: StoredFile,
): string | undefined {
  const [url, setUrl] = useState<string>();

  useEffect(() => {
    if (
      !file ||
      (!isImageFile(file) && !isVideoFile(file)) ||
      (!file.handleKey && !file.resourceKey)
    ) {
      setUrl(undefined);
      return;
    }
    let disposed = false;
    let objectUrl: string | undefined;
    void readStoredResourceFile(file, false)
      .then((resource) => {
        if (!resource || disposed) return;
        objectUrl = URL.createObjectURL(resource);
        setUrl(objectUrl);
      })
      .catch(() => setUrl(undefined));
    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [file?.handleKey, file?.mime, file?.resourceKey]);

  return url;
}

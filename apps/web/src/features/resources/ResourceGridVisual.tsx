import {
  File as FileIcon,
  ImageSquare,
  VideoCamera,
} from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import type { StoredMessage } from "../../store";
import {
  isImageFile,
  isVideoFile,
} from "./resource-access";
import { useResourceObjectUrl } from "./use-resource-object-url";

export function ResourceGridVisual({
  message,
}: {
  message: StoredMessage;
}) {
  const file = message.file;
  const resourceUrl = useResourceObjectUrl(file);
  const [previewFailed, setPreviewFailed] = useState(false);
  useEffect(() => setPreviewFailed(false), [resourceUrl]);
  if (resourceUrl && !previewFailed && isImageFile(file)) {
    return (
      <img
        src={resourceUrl}
        alt=""
        loading="lazy"
        onError={() => setPreviewFailed(true)}
      />
    );
  }
  if (resourceUrl && !previewFailed && isVideoFile(file)) {
    return (
      <video
        src={resourceUrl}
        muted
        playsInline
        preload="metadata"
        onError={() => setPreviewFailed(true)}
      />
    );
  }
  if (isImageFile(file)) {
    return <ImageSquare size={32} weight="duotone" />;
  }
  if (isVideoFile(file)) {
    return <VideoCamera size={32} weight="duotone" />;
  }
  return <FileIcon size={32} weight="duotone" />;
}

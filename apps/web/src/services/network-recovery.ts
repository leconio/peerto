export function canRestoreExistingPeerConnection(
  controlChannelState: RTCDataChannelState | undefined,
  connectionState: RTCPeerConnectionState | undefined,
): boolean {
  return (
    controlChannelState === "open" && connectionState === "connected"
  );
}

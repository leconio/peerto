export function rtcConfiguration(
  iceServers: RTCIceServer[],
  relayOnly = false,
): RTCConfiguration {
  return {
    iceServers,
    iceTransportPolicy: relayOnly ? "relay" : "all",
  };
}

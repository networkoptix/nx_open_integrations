// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * Live video from one Nx camera in the browser, over WebRTC.
 *
 * This is a thin, well-commented wrapper around Network Optix's official
 * browser library, @networkoptix/webrtc-stream-manager. The library does the
 * hard part (WebRTC signaling, ICE, the media pipeline); this file just feeds
 * it the three things it needs — which site, which camera, and a token — and
 * points the resulting video stream at a <video> element.
 *
 * HOW THE LIVE VIDEO PATH WORKS (and why it does NOT use the proxy):
 *
 *   The camera list and login in this sample are plain HTTP and are blocked by
 *   the browser's CORS rule, so they go through the local proxy (see proxy.mjs
 *   / server.mjs). The live VIDEO is different: the stream manager opens a
 *   WebSocket straight to the site's relay
 *       wss://<siteId>.relay.vmsproxy.com/rest/v3/devices/<cameraId>/webrtc
 *   to exchange the WebRTC handshake, then the video flows peer-to-peer.
 *   WebSockets are NOT subject to CORS, so this connects directly — no proxy.
 *
 * The library is ESM-only and depends on rxjs, so we load it from esm.sh (which
 * resolves those dependencies) instead of bundling. The import is LAZY — done
 * inside startLiveView — so this module can be imported by the offline tests
 * without reaching the network. Tests inject a fake loader.
 *
 * Library API used (v0.1.29):
 *   StreamManager.configure(managerConfig)         // once, before getInstance()
 *   StreamManager.getInstance().connect(urlConfig) // -> CameraConnection
 *   connection.on('track', ({ streams }) => ...)   // attach to <video>
 *   connection.on('error', (err) => ...)
 */

// The default place we load the library from. Pinned to an exact version so
// the sample is reproducible. esm.sh serves it as a browser-ready ES module
// with its rxjs/webrtc-issue-detector dependencies already resolved.
export const STREAM_MANAGER_URL =
  "https://esm.sh/@networkoptix/webrtc-stream-manager@0.1.29";

export const RELAY_SUFFIX = ".relay.vmsproxy.com";

// ---------------------------------------------------------------------------
// Pure helpers (no library, no network) — these are what the tests cover.
// ---------------------------------------------------------------------------

/**
 * The relay host the stream manager should target for a given site. The
 * library wants the bare host (no scheme); it adds wss:// itself.
 */
export function relayHostFor(siteId) {
  return `${siteId}${RELAY_SUFFIX}`;
}

/**
 * The one-time global config for StreamManager.configure().
 * @param {string} siteId  Cloud Site ID (UUID).
 */
export function buildManagerConfig(siteId) {
  return {
    relayUrl: relayHostFor(siteId),
    useRelayPrefix: true,
    maxBehind: 5,
    useUnreliableDataChannel: true,
  };
}

/**
 * The per-camera connect() config.
 * @param {object} p
 * @param {string} p.siteId
 * @param {string} p.cameraId       Camera/device id (cam.id from the list).
 * @param {string|Function} p.accessToken  The SITE-SCOPED bearer token (the
 *        same token login() returns), or a function/async function returning it.
 * @param {string} [p.targetStream] "AUTO" | "HIGH" | "LOW" (default "AUTO").
 */
export function buildStreamConfig({ siteId, cameraId, accessToken, targetStream = "AUTO" }) {
  if (!siteId) throw new Error("buildStreamConfig: siteId is required");
  if (!cameraId) throw new Error("buildStreamConfig: cameraId is required");
  if (!accessToken) throw new Error("buildStreamConfig: accessToken is required");
  return { systemId: siteId, cameraId, accessToken, targetStream };
}

// ---------------------------------------------------------------------------
// Live view (uses the library)
// ---------------------------------------------------------------------------

/**
 * Start live video for one camera and render it into a <video> element.
 *
 * @param {object} p
 * @param {HTMLVideoElement} p.video       Where the picture goes.
 * @param {string} p.siteId
 * @param {string} p.cameraId
 * @param {string|Function} p.accessToken  Site-scoped bearer token (or factory).
 * @param {string} [p.targetStream]        "AUTO" | "HIGH" | "LOW".
 * @param {(err:Error)=>void} [p.onError]  Called on a stream error.
 * @param {() => Promise<any>} [p.loadStreamManager] Test seam: returns the
 *        library module. Defaults to a dynamic import from esm.sh.
 * @returns {Promise<{stop: () => void}>}  Call stop() to tear the stream down.
 */
export async function startLiveView({
  video,
  siteId,
  cameraId,
  accessToken,
  targetStream = "AUTO",
  onError = null,
  loadStreamManager = null,
}) {
  if (!video) throw new Error("startLiveView: a <video> element is required");

  // Build (and validate) our config up front — pure, throws clearly if wrong.
  const managerConfig = buildManagerConfig(siteId);
  const streamConfig = buildStreamConfig({ siteId, cameraId, accessToken, targetStream });

  // Lazily load the library (or the injected fake in tests).
  const mod = loadStreamManager
    ? await loadStreamManager()
    : await import(/* @vite-ignore */ STREAM_MANAGER_URL);

  const { StreamManager, TargetStream } = mod;
  if (!StreamManager) {
    throw new Error("webrtc-stream-manager did not export StreamManager.");
  }
  // Map our plain string to the library's enum if it provides one.
  if (TargetStream && TargetStream[targetStream] !== undefined) {
    streamConfig.targetStream = TargetStream[targetStream];
  }

  StreamManager.configure(managerConfig);
  const connection = StreamManager.getInstance().connect(streamConfig);

  // Attach the incoming media track to the <video>.
  connection.on("track", ({ streams }) => {
    if (streams && streams[0]) {
      video.srcObject = streams[0];
      video.muted = true; // browsers block autoplay of unmuted video
      video.autoplay = true;
      video.playsInline = true;
    }
  });

  connection.on("error", (err) => {
    if (onError) onError(err instanceof Error ? err : new Error(String(err)));
  });

  // A small, defensive teardown — method names have varied across versions,
  // so we try the common ones and always release the <video>.
  const stop = () => {
    try {
      if (typeof connection.close === "function") connection.close();
      else if (typeof connection.dispose === "function") connection.dispose();
      else if (typeof connection.disconnect === "function") connection.disconnect();
    } catch {
      // best effort
    }
    if (video) video.srcObject = null;
  };

  return { stop, connection };
}

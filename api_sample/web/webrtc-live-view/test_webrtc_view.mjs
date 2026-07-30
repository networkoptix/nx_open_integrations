// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * Offline tests for webrtc-view.mjs. No network, no library download, no
 * browser. The actual @networkoptix/webrtc-stream-manager is third-party and
 * not unit-tested here; we test the logic we own (config building) and the
 * wiring of startLiveView() using an INJECTED fake library + fake <video>.
 *
 * Run from this folder:  node --test test_webrtc_view.mjs
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  relayHostFor,
  buildManagerConfig,
  buildStreamConfig,
  startLiveView,
  RELAY_SUFFIX,
} from "./webrtc-view.mjs";

const SITE = "11111111-2222-3333-4444-555555555555";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test("relayHostFor builds the bare relay host (no scheme)", () => {
  assert.equal(relayHostFor(SITE), `${SITE}${RELAY_SUFFIX}`);
  assert.equal(relayHostFor(SITE), `${SITE}.relay.vmsproxy.com`);
});

test("buildManagerConfig points the manager at the site relay", () => {
  const cfg = buildManagerConfig(SITE);
  assert.equal(cfg.relayUrl, `${SITE}.relay.vmsproxy.com`);
  assert.equal(cfg.useRelayPrefix, true);
});

test("buildStreamConfig maps our names to the library's (systemId/cameraId/accessToken)", () => {
  const cfg = buildStreamConfig({ siteId: SITE, cameraId: "cam-1", accessToken: "nxcdb-t" });
  assert.equal(cfg.systemId, SITE); // library calls the site id "systemId"
  assert.equal(cfg.cameraId, "cam-1");
  assert.equal(cfg.accessToken, "nxcdb-t");
  assert.equal(cfg.targetStream, "AUTO");
});

test("buildStreamConfig rejects missing required fields", () => {
  assert.throws(() => buildStreamConfig({ cameraId: "c", accessToken: "t" }), /siteId/);
  assert.throws(() => buildStreamConfig({ siteId: SITE, accessToken: "t" }), /cameraId/);
  assert.throws(() => buildStreamConfig({ siteId: SITE, cameraId: "c" }), /accessToken/);
});

// ---------------------------------------------------------------------------
// startLiveView() wiring — with a fake library and a fake <video>
// ---------------------------------------------------------------------------

function fakeVideo() {
  return { srcObject: "untouched", muted: false, autoplay: false, playsInline: false };
}

/**
 * A fake StreamManager module mirroring the parts we use. Records what it was
 * configured/connected with, and lets the test fire the 'track'/'error' events.
 */
function fakeLibrary() {
  const handlers = {};
  const connection = {
    on(event, cb) {
      handlers[event] = cb;
      return () => delete handlers[event];
    },
    closed: false,
    close() {
      this.closed = true;
    },
  };
  const record = { configuredWith: null, connectedWith: null, getInstanceCalls: 0 };
  const StreamManager = {
    configure(cfg) {
      record.configuredWith = cfg;
    },
    getInstance() {
      record.getInstanceCalls += 1;
      return { connect(urlConfig) {
        record.connectedWith = urlConfig;
        return connection;
      } };
    },
  };
  const mod = { StreamManager, TargetStream: { AUTO: 0, HIGH: 1, LOW: 2 } };
  return { mod, record, connection, fire: (e, payload) => handlers[e] && handlers[e](payload) };
}

test("startLiveView configures the manager and connects with our config", async () => {
  const { mod, record } = fakeLibrary();
  const video = fakeVideo();
  await startLiveView({
    video,
    siteId: SITE,
    cameraId: "cam-9",
    accessToken: "nxcdb-tok",
    loadStreamManager: async () => mod,
  });
  assert.equal(record.configuredWith.relayUrl, `${SITE}.relay.vmsproxy.com`);
  assert.equal(record.connectedWith.systemId, SITE);
  assert.equal(record.connectedWith.cameraId, "cam-9");
  assert.equal(record.connectedWith.accessToken, "nxcdb-tok");
  // "AUTO" should be mapped to the library's enum value (0 in our fake).
  assert.equal(record.connectedWith.targetStream, 0);
});

test("a 'track' event attaches the stream to the <video>", async () => {
  const { mod, fire } = fakeLibrary();
  const video = fakeVideo();
  await startLiveView({ video, siteId: SITE, cameraId: "c", accessToken: "t", loadStreamManager: async () => mod });
  const stream = { id: "media-stream" };
  fire("track", { streams: [stream] });
  assert.equal(video.srcObject, stream);
  assert.equal(video.muted, true);
  assert.equal(video.autoplay, true);
});

test("an 'error' event is forwarded to onError", async () => {
  const { mod, fire } = fakeLibrary();
  let got = null;
  await startLiveView({
    video: fakeVideo(), siteId: SITE, cameraId: "c", accessToken: "t",
    onError: (e) => { got = e; },
    loadStreamManager: async () => mod,
  });
  fire("error", "boom");
  assert.ok(got instanceof Error);
  assert.match(got.message, /boom/);
});

test("stop() closes the connection and releases the video", async () => {
  const { mod, connection } = fakeLibrary();
  const video = fakeVideo();
  const { stop } = await startLiveView({ video, siteId: SITE, cameraId: "c", accessToken: "t", loadStreamManager: async () => mod });
  stop();
  assert.equal(connection.closed, true);
  assert.equal(video.srcObject, null);
});

test("startLiveView requires a <video> element", async () => {
  await assert.rejects(
    () => startLiveView({ video: null, siteId: SITE, cameraId: "c", accessToken: "t", loadStreamManager: async () => fakeLibrary().mod }),
    /video/,
  );
});

test("startLiveView surfaces a missing StreamManager export clearly", async () => {
  await assert.rejects(
    () => startLiveView({ video: fakeVideo(), siteId: SITE, cameraId: "c", accessToken: "t", loadStreamManager: async () => ({}) }),
    /did not export StreamManager/,
  );
});

// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/*
 * Shared TypeScript models for the Nx API samples.
 *
 * This file is TYPES ONLY (interfaces + type aliases). Every sample imports it
 * with `import type { ... } from "../nx-types.ts"`, so Node's type stripping
 * removes the import entirely at runtime — there is no runtime coupling, and
 * each sample still runs on its own. The shared file exists so the API shapes
 * are described once, in one place, and type-checked across all samples.
 *
 * These shapes are intentionally lenient: the Nx API may return more fields
 * than a sample uses, so response types keep an index signature and most
 * fields are optional. The samples narrow what they actually read.
 *
 * API paths are written without the double-asterisk that would otherwise close
 * a doc comment early.
 */

// ---------------------------------------------------------------------------
// Fetch seam
// ---------------------------------------------------------------------------

/**
 * The shape of the global `fetch`. Samples accept an injectable `FetchImpl` so
 * tests can run offline with a fake fetch — the same seam the Node samples use.
 */
export type FetchImpl = typeof globalThis.fetch;

// ---------------------------------------------------------------------------
// Cloud OAuth2 (CDB)  —  POST /cdb/oauth2/token
// ---------------------------------------------------------------------------

/** The OAuth2 client id every sample sends. */
export type ClientId = "3rdParty";

/** Request body for the password grant (initial login). */
export interface OAuthPasswordGrant {
  grant_type: "password";
  response_type: "token";
  client_id: ClientId;
  username: string;
  password: string;
  /** Present only for 2FA accounts. */
  mfaCode?: string;
  /** Scope a token to one site, e.g. "cloudSystemId=<id>"; omit for cloud-wide. */
  scope?: string;
}

/** Request body for the refresh grant (renew without the password). */
export interface OAuthRefreshGrant {
  grant_type: "refresh_token";
  response_type: "token";
  client_id: ClientId;
  refresh_token: string;
}

/** Response from the token endpoint. `access_token` is prefixed `nxcdb-`. */
export interface TokenResponse {
  access_token: string;
  token_type?: string;
  /** Seconds until the access token expires. */
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Sites (a.k.a. "systems" on the wire)  —  GET /cdb/systems
// ---------------------------------------------------------------------------

/**
 * One site registered to a cloud account. The wire endpoint is /cdb/systems and
 * the response may be a bare array or an envelope; the sample unwraps it.
 */
export interface Site {
  id: string;
  name?: string;
  stateOfHealth?: string;
  version?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// VMS server login  —  POST /rest/v4/login/sessions  (direct, not relay)
// ---------------------------------------------------------------------------

export interface LoginRequest {
  username: string;
  password: string;
  /** Samples use bearer tokens, so cookies are disabled. */
  setCookie: false;
}

export interface LoginResponse {
  token: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Devices / cameras  —  GET /rest/v4/devices
// ---------------------------------------------------------------------------

/** A device as returned by the server (lenient — many more fields exist). */
export interface Camera {
  id?: string;
  name?: string;
  status?: string;
  model?: string;
  [key: string]: unknown;
}

/** The four columns the samples render after normalizing the response. */
export interface DeviceSummary {
  name: string;
  status: string;
  model: string;
  id: string;
}

// ---------------------------------------------------------------------------
// Event log  —  GET /rest/v4/events/log
// ---------------------------------------------------------------------------

/** Query parameters for the event log. eventType/actionType are repeatable. */
export interface EventLogQuery {
  startTimeMs: number;
  durationMs: number;
  eventType?: string[];
  actionType?: string[];
  order?: "asc" | "desc";
  limit?: number;
}

/** A raw event-log record. Details live inside eventData / actionData. */
export interface EventRecord {
  timestampMs?: number;
  eventData?: Record<string, unknown>;
  actionData?: Record<string, unknown>;
  ruleId?: string;
  flags?: string;
  [key: string]: unknown;
}

/** A flattened row the samples render in the table. */
export interface EventRow {
  timeIso: string;
  eventType: string;
  actionType: string;
  resource: string;
}

// ---------------------------------------------------------------------------
// Event-type manifest  —  GET /rest/v4/events/manifest/events
// ---------------------------------------------------------------------------

/** One entry from the event-type manifest. */
export interface ManifestEntry {
  id: string;
  displayName: string;
  [key: string]: unknown;
}

/**
 * The manifest is an OBJECT MAP keyed by event-type id; each value is a
 * ManifestEntry. Samples flatten it to id -> displayName for a filter list.
 */
export type EventManifest = Record<string, ManifestEntry>;

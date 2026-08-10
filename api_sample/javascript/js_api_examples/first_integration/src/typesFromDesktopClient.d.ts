// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

export {};

declare global {
  /** A camera/device known to the current VMS session. */
  interface Resource {
    /** Unique, stable identifier for this resource. */
    id: string;
    /** Resource kind, e.g. "camera". */
    type: string;
    /** Human-readable display name. */
    name: string;
  }

  /** A connect-only event signal, as exposed by the Desktop Client's injected API. */
  interface Signal<Callback> {
    connect(callback: Callback): void;
  }

  interface VmsResourcesApi {
    /** Resources visible to the current session's access rights. */
    resources(): Promise<Resource[]>;
    /** Fires when a resource becomes visible to this session (including updates to an existing one). */
    added: Signal<(resource: Resource) => void>;
    /** Fires with the id of a resource that is no longer visible to this session. */
    removed: Signal<(resourceId: string) => void>;
    /** Whether this resource actually has a video stream (vs. e.g. a server or layout resource). */
    hasMediaStream(resourceId: string): Promise<boolean>;
  }

  /** Error result shape returned by mutating `window.vms` calls. */
  interface VmsError {
    code: number;
    description?: string;
  }

  interface AddItemResult {
    error: VmsError;
    /** Present when `error.code === window.vms.ErrorCode.success`. */
    item?: { id: string };
  }

  interface VmsTab {
    name: string;
    /** Adds a resource to this tab's layout as a new scene item. Duplicates are allowed. */
    addItem(resourceId: string, params: Record<string, unknown>): Promise<AddItemResult>;
  }
  interface VmsLogApi {
    info(message: string): void;
  }
  interface VmsApi {
    resources: VmsResourcesApi;
    tab: VmsTab;
    log: VmsLogApi;
    /** Result codes returned in `VmsError.code`; compare against `ErrorCode.success`. */
    ErrorCode: { success: number; [key: string]: number };
  }

  interface InjectedObjects extends Record<any, any> {
    vms: VmsApi;
  }

  interface Window extends InjectedObjects {
    /** True once the Desktop Client has injected the JS API into this page. */
    isVmsApiEnabled?: boolean;
    /** Called by the Desktop Client once the JS API is ready to use. */
    vmsApiInit?: () => void | Promise<void>;
  }
}

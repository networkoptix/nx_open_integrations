// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
import { addOrUpdateResourceRow, removeResourceRow } from "./helpers";

/**
 * Wires up the camera list: populates it with the resources already visible
 * to this session that actually have a video stream, then keeps it live as
 * such resources are added, updated, or removed. Clicking a row adds that
 * camera to the current layout as a new item.
 *
 * NOTE: this reads resources via the current session's token, which may grant
 * access across multiple sites if the account has that permission — not just
 * resources scoped to this integration's origin site. That's expected: some
 * cross-site features (e.g. cloud layouts) rely on a single session token
 * reaching resources across sites/tenants.
 */
export const initResourcesUI = async (list: HTMLElement, toggle: HTMLElement) => {
  const addIfCamera = async (resource: Resource) => {
    const hasMedia = await window.vms.resources.hasMediaStream(resource.id);
    if (hasMedia) addOrUpdateResourceRow(list, toggle, resource);
  };

  window.vms.resources.added.connect(addIfCamera);
  window.vms.resources.removed.connect((resourceId) => removeResourceRow(list, toggle, resourceId));

  const resources = await window.vms.resources.resources();
  await Promise.all(resources.map(addIfCamera));
};

// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
import {
  addSelectionHandler,
  addOrUpdateListItem,
  removeItem,
  updateItemHandler,
} from "./helpers";

/**
 * Handles scene items insertions/changes/removals.
 * @param {*} list
 */
export const initSceneItemsUI = async (list) => {
  const handleSelectionChanged = addSelectionHandler(list, [
    window.removeItemButton,
    window.itemSettingsButton,
    window.syncWithButton,
  ]);

  window.vms.tab.itemAdded.connect(updateItemHandler(list));
  window.vms.tab.itemChanged.connect(updateItemHandler(list));
  window.vms.tab.itemRemoved.connect((itemId) => {
    removeItem(list, itemId);
    handleSelectionChanged();
  });

  const state = await window.vms.tab.state();
  state.items.forEach(updateItemHandler(list));
}

/**
 * Handles resources additions/removals and manages list of available resource items.
 * @param {*} list
 */
export const initResourcesUI = async (list) => {
  const handleSelectionChanged = addSelectionHandler(list, [
    window.addSceneItemButton,
    window.addSceneItemButtonWithParams,
  ]);

  const resourceAdded = (resource) => {
    const text = `[${resource.type}] ${resource.name}`;
    addOrUpdateListItem(list, resource.id, text);
  };

  window.vms.resources.added.connect((resource) => resourceAdded(resource));
  window.vms.resources.removed.connect((resourceId) => {
    removeItem(list, resourceId);
    handleSelectionChanged();
  });

  const resources = await window.vms.resources.resources();
  resources.forEach(resourceAdded);
}

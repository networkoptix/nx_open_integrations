// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
import {
  addSelectionHandler,
  addOrUpdateListItem,
  removeItem,
  clearList,
  getSelectedItemId,
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

  window.vms.tabs.currentTabItemAdded.connect(updateItemHandler(list));
  window.vms.tabs.currentTabItemChanged.connect(updateItemHandler(list));
  window.vms.tabs.currentTabItemRemoved.connect((itemId) => {
    removeItem(list, itemId);
    handleSelectionChanged();
  });

  let updateState = async () => {
    const state = await window.vms.tabs.current.state();
    state.items.forEach(updateItemHandler(list));
  };

  window.vms.tabs.currentChanged.connect(() => {
    clearList(list);
    updateState();
  });

  updateState();
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

/**
 * Handles tab list.
 * @param {*} list
 */
export const initTabsUi = async (list) => {
  const updateTab = async (tab) => {
    const isCurrent = window.vms.tabs.current.id === tab.id;
    const text = `${tab.name} ${isCurrent ? "(current)" : ""}`;
    addOrUpdateListItem(list, tab.id, text);
  };

  let updateTabs = () => {
    clearList(list)
    window.vms.tabs.tabs.forEach(updateTab);
  };

  window.vms.tabs.tabsChanged.connect(updateTabs);
  window.vms.tabs.currentChanged.connect(updateTabs);

  updateTabs();
}

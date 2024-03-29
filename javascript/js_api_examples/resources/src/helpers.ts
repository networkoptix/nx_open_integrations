// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

/**
 * Helper function. Adds or updates list item with specified id and text.
 * @param list
 * @param itemId
 * @param text
 */
export const addOrUpdateListItem = (list, itemId, text) => {
  let item = list.options.namedItem(itemId);
  if (!item) {
    item = document.createElement("option");
    item.id = itemId;
    list.append(item);
  }

  item.innerText = text;
}

/**
 * Helper function. Removes item with specified id from the list.
 * @param list
 * @param itemId
 */
export const removeItem = (list, itemId) => {
  const item = list.options.namedItem(itemId);
  if (item) list.remove(item.index);
}

/**
 * Removes all items from the list.
 */
export const clearList = (list) => {
  for (let i = list.options.length - 1; i >= 0; --i)
    list.remove(i);
}

/**
 * Disables specified buttons if list has no currently selected item. Otherwise enables them.
 * @param list
 * @param buttons
 * @returns
 */
export const addSelectionHandler = (list, buttons) => {
  const handleSelectionChanged = () => {
    const disabled = list.selectedIndex == -1;
    buttons.forEach((button) => (button.disabled = disabled));
  };

  list.addEventListener("change", handleSelectionChanged);
  handleSelectionChanged();

  return handleSelectionChanged;
}

/**
 * Returns id of selected list item, otherwise shows error with specified text.
 * @param list
 * @param errorMessage
 * @returns
 */
export const getSelectedItemId = (list, errorMessage) => {
  if (list.selectedIndex != -1) return list.item(list.selectedIndex).id;

  alert(errorMessage);
  return undefined;
}

export const updateEditsAvailability = () => {
  window.minLayoutSizeWidthEdit.disabled = !(<any>window).minLayoutSizeCheckbox
    .checked;
  window.minLayoutSizeHeightEdit.disabled = !(<any>window).minLayoutSizeCheckbox
    .checked;
}

export const timestampToString = (timestampMs) => {
  const timeZoneOffsetMs = new Date().getTimezoneOffset() * 60 * 1000;
  return new Date(timestampMs - timeZoneOffsetMs)
    .toISOString()
    .slice(0, -5);
};

export const updateItemHandler = (list) => (item) => {
  let text = `${item.resource.name} [${item.resource.type}]
                geometry[${item.params.geometry.pos.x},${item.params.geometry.pos.y},
                ${item.params.geometry.size.width}x${item.params.geometry.size.height}]`;

  if (item.params.media) {
    if (item.params.media.speed) text += `, (${item.params.media.speed}X)`;
    if (item.params.media.timestampMs)
      text += `, time(${item.params.media.timestampMs})`;
    if (item.params.media.timelineWindow)
      text += `, win(${item.params.media.timelineWindow.durationMs})`;
    if (item.params.media.timelineSelection)
      text += `, sel(${item.params.media.timelineSelection.durationMs})`;
  }

  if (item.params.selected) text = "+" + text;
  if (item.params.focused) text = "> " + text;

  addOrUpdateListItem(list, item.id, text);
};

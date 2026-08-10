// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

const VISIBLE_LIMIT = 5;

const findRow = (list: HTMLElement, resourceId: string): HTMLLIElement | undefined =>
  Array.from(list.children).find(
    (child) => (child as HTMLElement).dataset.id === resourceId
  ) as HTMLLIElement | undefined;

/**
 * Recomputes which rows are visible vs. hidden-until-expanded, based on
 * current DOM order. Must be re-run after every add/remove so pagination
 * stays correct as resources come and go (e.g. removing a visible camera
 * promotes the next hidden one into view).
 */
export const refreshVisibility = (list: HTMLElement, toggle: HTMLElement) => {
  const rows = Array.from(list.children) as HTMLElement[];
  rows.forEach((row, index) => row.classList.toggle("extra", index >= VISIBLE_LIMIT));

  const countEl = document.getElementById("cameraCount");
  if (countEl) countEl.textContent = `(${rows.length})`;

  if (rows.length > VISIBLE_LIMIT) {
    toggle.style.display = "inline-flex";
  } else {
    toggle.style.display = "none";
    list.classList.remove("expanded");
  }
};

/** Adds a resource as a new item to this tab, which contains the integration webpage.
  * Duplicate clicks are allowed. */
export const addResourceToLayout = async (resourceId: string) => {
  
  const result = await window.vms.tab.addItem(resourceId, {});
  
  // Worth knowing: If you want to interact with multiple tabs, you can use the `window.vms.tab.getTabs()` method 
  // to get a list of all tabs and then call `addItem` on the desired tab. 

  if (result.error.code === window.vms.ErrorCode.success) {
    window.vms.log.info(`Added item ${result.item?.id} for resource ${resourceId} to the current layout.`);
  } else {
    window.vms.log.info(`Could not add resource ${resourceId} to the current layout (error code ${result.error.code}).`);
  }
};

/**
 * Adds a row for a resource, or refreshes its label in place if a row for
 * that resource id already exists. Clicking a row adds that camera to the
 * current layout.
 */
export const addOrUpdateResourceRow = (list: HTMLElement, toggle: HTMLElement, resource: Resource) => {
  let row = findRow(list, resource.id);

  if (!row) {
    row = document.createElement("li");
    row.dataset.id = resource.id;
    row.tabIndex = 0;

    const tag = document.createElement("span");
    tag.className = "tag";
    row.appendChild(tag);
    row.appendChild(document.createTextNode(""));

    row.addEventListener("click", () => addResourceToLayout(resource.id));

    list.appendChild(row);
  }

  (row.querySelector(".tag") as HTMLElement).textContent = resource.type;
  row.lastChild!.textContent = resource.name;

  refreshVisibility(list, toggle);
};

/** Removes the row for a resource id, if a matching row is present. */
export const removeResourceRow = (list: HTMLElement, toggle: HTMLElement, resourceId: string) => {
  findRow(list, resourceId)?.remove();
  refreshVisibility(list, toggle);
};

// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

import { getSelectedItemId, timestampToString, updateEditsAvailability } from "./helpers";

export class LayoutSettingsController {
  /**
   * Manages layout settings. Now only "minimal layout size" property is supported.
   */
  constructor() {
    window.submitLayoutSettings.addEventListener("click", () => {
      const properties = {
        minimumSize: {
          width:
            window.minLayoutSizeCheckbox.checked &&
              window.minLayoutSizeWidthEdit.value
              ? window.minLayoutSizeWidthEdit.value
              : 0,
          height:
            window.minLayoutSizeCheckbox.checked &&
              window.minLayoutSizeHeightEdit.value
              ? window.minLayoutSizeHeightEdit.value
              : 0,
        },
      };

      window.vms.tab.setLayoutProperties(properties);
      window.vms.tab.saveLayout();
    });

    window.minLayoutSizeCheckbox.addEventListener(
      "change",
      updateEditsAvailability
    );
  }

  async changeLayoutSettings() {
    const state = await window.vms.tab.state();
    const minSize = state.properties.minimumSize;
    window.minLayoutSizeCheckbox.checked = !!minSize;

    window.minLayoutSizeWidthEdit.value = (<any>window).minLayoutSizeCheckbox
      .checked
      ? minSize.width
      : "";

    window.minLayoutSizeHeightEdit.value = (<any>window).minLayoutSizeCheckbox
      .checked
      ? minSize.height
      : "";

    updateEditsAvailability();
    window.layoutSettingsDialog.showModal();
  }
}

export class SceneItemsController {
  dialogData: Record<any, any> = {
    itemId: null,
    resourceId: null // Id of the related resource.
  };

  /**
   * Controller for scene items management. Allows to add/remove/setup items.
   */
  constructor() {
    this.initListeners();
  }

  private initListeners() {

    window.setNowTimeButton.addEventListener("click", (e) => {
      e.preventDefault();

      window.dateTimeControl.value = timestampToString(Date.now());
    });

    window.setCurrentDeviceTimeButton.addEventListener(
      "click",
      async (e) => {
        e.preventDefault();

        if (!this.dialogData.itemId) return;

        const itemResult = await window.vms.tab.item(this.dialogData.itemId);
        if (itemResult.error.code != window.vms.ErrorCode.success) return;

        const timestampMs =
          itemResult.item &&
          itemResult.item.params.media &&
          itemResult.item.params.media.timestampMs;

        if (timestampMs)
          window.dateTimeControl.value = timestampToString(
            timestampMs * 1 /**Force integer value**/
          );
      }
    );

    window.clearTimeButton.addEventListener("click", (e) => {
      e.preventDefault();

      window.dateTimeControl.value = null;
    });

    window.settingsSubmitButton.addEventListener("click", async () => {
      let settings: Record<any, any> = {};

      settings.selected = window.selectedCheckbox.checked;
      settings.focused = window.focusedCheckbox.checked;

      if (
        window.xEdit.value &&
        window.yEdit.value &&
        window.widthEdit.value &&
        window.heightEdit.value
      ) {
        settings.geometry = {
          pos: { x: window.xEdit.value, y: window.yEdit.value },
          size: {
            width: window.widthEdit.value,
            height: window.heightEdit.value,
          },
        };
      }

      const result = await window.vms.resources.resource(
        this.dialogData.resourceId
      );
      if (result.error.code == window.vms.ErrorCode.success) {
        const resource = result.resource;
        const hasMedia = await window.vms.resources.hasMediaStream(resource.id);
        if (hasMedia) {
          settings.media = {};

          if (window.speedInput.value)
            settings.media.speed = window.speedInput.value;

          if (window.dateTimeControl.value) {
            const timestampMs = new Date(
              window.dateTimeControl.value
            ).getTime();
            settings.media.timestampMs = timestampMs;

            const selectionLength = 6 * 1000;
            settings.media.timelineSelection = {
              startTimeMs: timestampMs - selectionLength / 2,
              durationMs: selectionLength,
            };

            const windowSize = 60 * 60 * 1000;
            settings.media.timelineWindow = {
              startTimeMs: timestampMs - windowSize / 2,
              durationMs: windowSize,
            };
          }
        }
      }

      if (this.dialogData.itemId) {
        const result = await window.vms.tab.setItemParams(
          this.dialogData.itemId,
          settings
        );
        if (result.code == window.vms.ErrorCode.success)
          window.vms.log.info(
            `Changed item ${this.dialogData.itemId} parameters, result code is ${result.code}`
          );
        else
          window.vms.log.info(
            `Can't change item ${this.dialogData.itemId} parameters, result code is ${result.code}`
          );
      } else {
        const result = await window.vms.tab.addItem(
          this.dialogData.resourceId,
          settings
        );
        if (result.error.code == window.vms.ErrorCode.success)
          window.vms.log.info(
            `Added item ${result.item.id} with parameters, result code is ${result.error.code}`
          );
        else
          window.vms.log.info(
            `Can't add item with parameters, result code is ${result.error.code}`
          );
      }
    });
  }

  private async setupDialog(itemParameters?) {
    const result = await window.vms.resources.resource(
      this.dialogData.resourceId
    );
    if (result.error.code != window.vms.ErrorCode.success) return false;

    const resource = result.resource;
    const hasMedia = await window.vms.resources.hasMediaStream(resource.id);
    window.setCurrentDeviceTimeButton.style.visibility =
      this.dialogData.itemId && hasMedia ? "visible" : "collapse";

    window.mediaParamsSection.style.visibility = hasMedia
      ? "visible"
      : "collapse";

    window.speedInput.value =
      itemParameters && itemParameters.media && itemParameters.media.speed;

    window.selectedCheckbox.checked = itemParameters && itemParameters.selected;
    window.focusedCheckbox.checked = itemParameters && itemParameters.focused;

    window.xEdit.value =
      itemParameters && itemParameters.geometry && itemParameters.geometry.pos
        ? itemParameters.geometry.pos.x
        : "";

    window.yEdit.value =
      itemParameters && itemParameters.geometry && itemParameters.geometry.pos
        ? itemParameters.geometry.pos.y
        : "";

    window.widthEdit.value =
      itemParameters && itemParameters.geometry && itemParameters.geometry.size
        ? itemParameters.geometry.size.width
        : "";

    window.heightEdit.value =
      itemParameters && itemParameters.geometry && itemParameters.geometry.size
        ? itemParameters.geometry.size.height
        : "";

    window.dateTimeControl.value = null;

    return true;
  }

  async addSceneItem(askParams) {
    const resourceId = getSelectedItemId(
      window.resourcesList,
      "Please select item to be removed from the scene"
    );
    if (!resourceId) return;

    if (!askParams) {
      window.vms.tab.addItem(resourceId, {});
      return;
    }

    this.dialogData.itemId = undefined;
    this.dialogData.resourceId = resourceId;

    if (await this.setupDialog()) window.settingsDialog.showModal();
  }

  async changeItemSettings() {
    const itemId = getSelectedItemId(
      window.sceneItemsList,
      "Please select scene item"
    );

    if (!itemId) return;

    const result = await window.vms.tab.item(itemId);
    if (result.error.code != window.vms.ErrorCode.success) {
      alert("Can't find specified item");
      return;
    }
    this.dialogData.itemId = result.item.id;
    this.dialogData.resourceId = result.item.resource.id;

    if (await this.setupDialog(result.item.params))
      window.settingsDialog.showModal();
  }

  removeSceneItem() {
    const itemId = getSelectedItemId(
      window.sceneItemsList,
      "Please select item to be removed from the scene"
    );
    if (itemId) window.vms.tab.removeItem(itemId);
  }

  syncWith() {
    const itemId = getSelectedItemId(
      window.sceneItemsList,
      "Please select item to be synced with"
    );
    if (itemId) window.vms.tab.syncWith(itemId);
  }
}

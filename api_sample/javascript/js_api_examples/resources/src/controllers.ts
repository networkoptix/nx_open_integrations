// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

import { getSelectedItemId, timestampToString, updateEditsAvailability } from "./helpers";
import * as http from 'http';

export class LayoutSettingsController {
  /**
   * Manages layout settings. Now only "minimal layout size" and "locked" property are supported.
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
        locked: window.lockedLayoutCheckbox.checked
      };

      window.vms.tabs.current.setLayoutProperties(properties);
      window.vms.tabs.current.saveLayout();
    });

    window.minLayoutSizeCheckbox.addEventListener(
      "change",
      updateEditsAvailability
    );
    window.minimalInterfaceCheckbox.addEventListener(
      "change",
      () => {
        window.vms.self.setMinimalInterfaceMode(window.minimalInterfaceCheckbox.checked);
      }
    );
    window.preventDefaultContextMenu.addEventListener(
      "change",
      () => {
        window.vms.self.setPreventDefaultContextMenu(window.preventDefaultContextMenu.checked);
      }
    );
    window.preventDefaultContextMenu.addEventListener(
      "contextmenu",
      () => {
        window.alert("Contextmenu listener triggered");
      }
    );
  }

  async changeLayoutSettings() {
    const state = await window.vms.tabs.current.state();
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

    window.lockedLayoutCheckbox.checked = state.properties.locked;

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

  private setupDateTimeButtons(dateTimeControl, currentButton, nowButton, clearButton) {
    nowButton.addEventListener("click", (e) => {
      e.preventDefault();

      dateTimeControl.value = timestampToString(Date.now());
    });

    currentButton.addEventListener(
      "click",
      async (e) => {
        e.preventDefault();

        if (!this.dialogData.itemId) return;

        const itemResult = await window.vms.tabs.current.item(this.dialogData.itemId);
        if (itemResult.error.code != window.vms.ErrorCode.success) return;

        const timestampMs =
          itemResult.item &&
          itemResult.item.params.media &&
          itemResult.item.params.media.timestampMs;

        if (timestampMs)
          dateTimeControl.value = timestampToString(
            timestampMs * 1 /**Force integer value**/
          );
      }
    );

    clearButton.addEventListener("click", (e) => {
      e.preventDefault();

      dateTimeControl.value = null;
    });
  }

  private initListeners() {
    this.setupDateTimeButtons(
      window.dateTimeControl,
      window.setCurrentDeviceTimeButton,
      window.setNowTimeButton,
      window.clearTimeButton);

    this.setupDateTimeButtons(
      window.timelineStart,
      window.setCurrentTimelineStartButton,
      window.setNowTimelineStartButton,
      window.clearTimelineStartButton);

    this.setupDateTimeButtons(
      window.timelineEnd,
      window.setCurrentTimelineEndButton,
      window.setNowTimelineEndButton,
      window.clearTimelineEndButton);

    this.setupDateTimeButtons(
      window.selectionStart,
      window.setCurrentSelectionStartButton,
      window.setNowSelectionStartButton,
      window.clearSelectionStartButton);

    this.setupDateTimeButtons(
      window.selectionEnd,
      window.setCurrentSelectionEndButton,
      window.setNowSelectionEndButton,
      window.clearSelectionEndButton);

    window.advancedSettingsButton.addEventListener("click", () => {
      window.advancedSettingsDialog.showModal();
    });

    window.advancedSettingsSubmitButton.addEventListener("click", () => {
      window.settingsDialog.showModal();
    })

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

          }

          if (window.selectionStart.value && window.selectionEnd.value) {
            const selectionStart = new Date(window.selectionStart.value).getTime();
            const selectionEnd = new Date(window.selectionEnd.value).getTime();
            settings.media.timelineSelection = {
              startTimeMs: selectionStart,
              durationMs: selectionEnd - selectionStart
            };
          }

          if (window.timelineStart.value && window.timelineEnd.value) {
            const timelineStart = new Date(window.timelineStart.value).getTime();
            const timelineEnd = new Date(window.timelineEnd.value).getTime();
            settings.media.timelineWindow = {
              startTimeMs: timelineStart,
              durationMs: timelineEnd - timelineStart
            };
          }
        }
      }

      if (this.dialogData.itemId) {
        const result = await window.vms.tabs.current.setItemParams(
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
        const result = await window.vms.tabs.current.addItem(
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
    window.timelineStart.value = null;
    window.timelineEnd.value = null;
    window.selectionStart.value = null;
    window.selectionEnd.value = null;

    return true;
  }

  async addSceneItem(askParams) {
    const resourceId = getSelectedItemId(
      window.resourcesList,
      "Please select item to be removed from the scene"
    );
    if (!resourceId) return;

    const result = await window.vms.resources.resource(resourceId)
    if (result.error.code == window.vms.ErrorCode.success && result.resource.type == 'layout') {
      window.vms.tabs.open(resourceId);
      return;
    }

    if (!askParams) {
      window.vms.tabs.current.addItem(resourceId, {});
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

    const result = await window.vms.tabs.current.item(itemId);
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
    if (itemId) window.vms.tabs.current.removeItem(itemId);
  }

  syncWith() {
    const itemId = getSelectedItemId(
      window.sceneItemsList,
      "Please select item to be synced with"
    );
    if (itemId) window.vms.tabs.current.syncWith(itemId);
  }
}

export class AuthController {
  async updateServerToken() {
    const token = await window.vms.auth.sessionToken();
    window.serverToken.value = token;
  }

  async updateCloudToken() {
    const token = await window.vms.auth.cloudToken();
    window.cloudToken.value = token;
  }

  async updateCloudSystemId() {
    const value = await window.vms.auth.cloudSystemId();
    window.cloudSystemId.value = value;
  }

  async updateCloudHost() {
    const value = await window.vms.auth.cloudHost();
    window.cloudHost.value = value;
  }
}

export class TabsController {
  async open() {
    const id = getSelectedItemId(window.tabList, "Please select a tab");
    if (!id)
      return;

    const error = await window.vms.tabs.setCurrent(id);
    if (error.code != vms.ErrorCode.success && !!error.description)
      alert(error.description);
  }

  async remove() {
    const id = getSelectedItemId(window.tabList, "Please select a tab");
    if (!id)
      return;

    const error = await window.vms.tabs.remove(id);
    if (error.code != vms.ErrorCode.success && !!error.description)
      alert(error.description);
  }

  async add() {
    const name = window.tabName.value;
    const tab = await window.vms.tabs.add(name);
    if (!tab)
      alert("Could not add a tab");
  }
}

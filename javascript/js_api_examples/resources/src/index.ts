// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
import { SceneItemsController, LayoutSettingsController, AuthController, TabsController } from "./controllers";
import { initResourcesUI, initSceneItemsUI, initTabsUi } from "./initHandlers";

function showBanner(visible) {
  document.querySelector("#banner").style.display = visible ? "initial" : "none";
  document.querySelectorAll("section").forEach(
    section => section.style.display = visible ? "none" : "initial");
}

if (!window.isVmsApiEnabled) {
  window.onload = () => showBanner(true);
}

// Entry point for the Client API. After this callback call all functionality is available.
window.vmsApiInit = () => {
  showBanner(false);

  window.sceneItemsController = new SceneItemsController();
  window.layoutSettingsController = new LayoutSettingsController();
  window.tabsController = new TabsController();

  // vms.auth is available in the 5.1 version.
  if (window.vms.auth)
    window.authController = new AuthController();
  else
    window.authBlock.style.visibility = "hidden"

  initResourcesUI(window.resourcesList);
  initSceneItemsUI(window.sceneItemsList);
  initTabsUi(window.tabList);
};

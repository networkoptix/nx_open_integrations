// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
import { initResourcesUI } from "./initHandlers";

function showApp(isConnected: boolean) {
  document.getElementById("banner")!.style.display = isConnected ? "none" : "block";
  document.getElementById("app")!.style.display = isConnected ? "block" : "none";
}

if (!window.isVmsApiEnabled) {
  window.onload = () => showApp(false);
}

const cameraList = document.getElementById("cameraList") as HTMLUListElement;
const showAllToggle = document.getElementById("showAllToggle") as HTMLButtonElement;

showAllToggle.addEventListener("click", (event) => {
  const expanded = cameraList.classList.toggle("expanded");
  (event.currentTarget as HTMLButtonElement).textContent = expanded
    ? "Show fewer cameras ↑"
    : "Show all cameras ↓";
});

// Entry point for the Client API. After this callback call all functionality is available.
window.vmsApiInit = async () => {
  showApp(true);

  const helloEl = document.getElementById("hello")!;
  helloEl.innerHTML = `This Integration is now running inside tab <span>${window.vms.tab.name}</span>.`;

  await initResourcesUI(cameraList, showAllToggle);
};

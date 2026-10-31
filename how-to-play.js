"use strict";

// Help stays separate from the simulation and is only offered on the start screen.
(() => {
  const openButton = document.getElementById("how-to-play-button");
  const dialog = document.getElementById("how-to-play-dialog");
  const closeButton = document.getElementById("how-to-play-close");

  openButton.addEventListener("click", () => dialog.showModal());
  closeButton.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => openButton.focus({ preventScroll: true }));
})();

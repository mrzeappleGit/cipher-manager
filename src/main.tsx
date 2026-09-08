import React from "react";
import ReactDOM from "react-dom/client";
import { HashRouter } from "react-router-dom";
import App from "./App";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </React.StrictMode>
);

// Register the PWA service worker only in a real browser (not the Tauri
// webview, and not the baked snapshot page — its host has no /sw.js).
const isTauriShell = "__TAURI_INTERNALS__" in window;
const isSnapshotPage = "__CIPHER_SNAPSHOT__" in window;
if (!isTauriShell && !isSnapshotPage && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      /* installability is best-effort */
    });
  });
}

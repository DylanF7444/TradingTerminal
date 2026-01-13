import { invoke } from "@tauri-apps/api/core";
import React from "react"
import ReactDOM from "react-dom/client"
import App from "./App"

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)

let greetInputEl: HTMLInputElement | null;
let greetMsgEl: HTMLElement | null;
console.log(invoke("my_custom_command",{}));
async function greet() {
  if (greetMsgEl && greetInputEl) {
    // Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
    
    greetMsgEl.textContent = await invoke("greet", {
      name: greetInputEl.value,
    });
    greetMsgEl.textContent = "tedst";
    greetMsgEl.textContent = await invoke("my_custom_command",{});
  }
}

window.addEventListener("DOMContentLoaded", () => {
  greetInputEl = document.querySelector("#greet-input");
  greetMsgEl = document.querySelector("#greet-msg");
  document.querySelector("#greet-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    greet();
    
  });
});

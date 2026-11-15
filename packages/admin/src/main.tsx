import { mountAdmin } from "./mount.js";
import "./styles.css";

const rootEl = document.getElementById("root");
if (rootEl) {
  mountAdmin(rootEl);
}

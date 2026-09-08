import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AppBootstrap } from "./features/onboarding/AppBootstrap";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppBootstrap />
  </StrictMode>,
);

// src/main.jsx — React entry point
import React from "react";
import ReactDOM from "react-dom/client";
import Dashboard from "./pages/Dashboard.jsx";
import "./dashboard.css";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <Dashboard />
  </React.StrictMode>
);

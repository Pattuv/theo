import { createRoot } from "react-dom/client";
import "./index.css";
import Test from "./components/test";

const App = () => {
  const handleMouseEnter = () => {
    if (window.electron?.ipcRenderer) {
      window.electron.ipcRenderer.send("enable-mouse");
    }
  };

  const handleMouseLeave = () => {
    if (window.electron?.ipcRenderer) {
      window.electron.ipcRenderer.send("disable-mouse");
    }
  };

  return (
    <div
      className="pointer-events-auto"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <Test />
    </div>
  );
};

const container = document.getElementById("root");
const root = createRoot(container);
root.render(<App />);

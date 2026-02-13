import { useState, useEffect, useRef } from "react";
import mascot from "../assets/mascot.png";
import ping1 from "../assets/ping1.mp3";
import ping2 from "../assets/ping2.mp3";

function Notch({ taskbarHeight = 0 }) {
  const bottomOffset = taskbarHeight + 10;
  const [isHovered, setIsHovered] = useState(false);
  const [position, setPosition] = useState("bottom-left");
  const [isCtrlWinHeld, setIsCtrlWinHeld] = useState(false);
  const [helpCenterOpen, setHelpCenterOpen] = useState(false);
  const [clickThroughEnabled, setClickThroughEnabled] = useState(false);
  const [outputPlaying, setOutputPlaying] = useState(false);
  const [screenSize, setScreenSize] = useState({ width: 1920, height: 1080 });
  const helpCenterDialogRef = useRef(null);
  const humanInputConfirmRef = useRef(null);
  const notchContainerRef = useRef(null);
  const ping1Audio = useRef(null);
  const ping2Audio = useRef(null);
  // configs for input cooldowns and states
  const CTRL_WIN_COOLDOWN_MS = 2000;
  const lastCtrlWinAtRef = useRef(0);
  const isHoldingRef = useRef(false);
  const isRight = position.includes("right");
  const isBottom = position.includes("bottom");
  const containerSideClass = isRight ? "right-0" : "left-0";
  const rowDirClass = isRight ? "flex-row-reverse" : "flex-row";
  const overlapMargin = isRight ? "-ml-17" : "-mr-17";
  const padClass = isRight ? "pr-15 pl-5" : "pl-15 pr-5";
  const verticalStyle = isBottom
    ? { bottom: `${bottomOffset}px`, top: "auto" }
    : { top: "10px", bottom: "auto" };
  const moveBtnClass = (key) =>
    key === position
      ? "w-full border-2 border-black p-5 inter rounded-2xl flex justify-between items-center"
      : "w-full border border-gray-400 p-5 inter rounded-2xl flex justify-between items-center";
  const tooltipDirClass = isBottom ? "" : "tooltip-bottom";

  const isInputLocked = async () => {
    if (!window.electron?.ipcRenderer?.invoke) return false;
    try {
      const state = await window.electron.ipcRenderer.invoke(
        "get-input-lock-state",
      );
      return Boolean(state?.locked);
    } catch (err) {
      console.error("[UI] Failed to get input lock state:", err);
      return false;
    }
  };

  // audio objects
  useEffect(() => {
    ping1Audio.current = new Audio(ping1);
    ping2Audio.current = new Audio(ping2);

    // Preload audio
    ping1Audio.current.load();
    ping2Audio.current.load();
  }, []);

  // Listen for Ctrl+Win key events
  useEffect(() => {
    if (!window.electron?.ipcRenderer) return;

    const handleCtrlWinKeyDown = async () => {
      if (await isInputLocked()) {
        isHoldingRef.current = false;
        setIsCtrlWinHeld(false);
        return;
      }
      const now = Date.now();
      const canInterrupt = outputPlaying;
      if (!canInterrupt && now - lastCtrlWinAtRef.current < CTRL_WIN_COOLDOWN_MS) return;
      if (isHoldingRef.current) return;

      isHoldingRef.current = true;
      setIsCtrlWinHeld(true);
      if (ping1Audio.current) {
        ping1Audio.current.currentTime = 0;
        ping1Audio.current
          .play()
          .catch((err) => console.error("Error playing ping1:", err));
      }
    };

    const handleCtrlWinKeyUp = async () => {
      if (await isInputLocked()) {
        isHoldingRef.current = false;
        setIsCtrlWinHeld(false);
        return;
      }
      if (!isHoldingRef.current) return;

      isHoldingRef.current = false;
      lastCtrlWinAtRef.current = Date.now();
      setIsCtrlWinHeld(false);
      if (ping2Audio.current) {
        ping2Audio.current.currentTime = 0;
        ping2Audio.current
          .play()
          .catch((err) => console.error("Error playing ping2:", err));
      }
    };

    const handleInputLockChanged = ({ locked }) => {
      if (!locked) return;
      isHoldingRef.current = false;
      setIsCtrlWinHeld(false);
    };

    const handleOutputPlayingChanged = ({ detail }) => {
      setOutputPlaying(Boolean(detail?.playing));
    };

    window.electron.ipcRenderer.on("ctrl-win-key-down", handleCtrlWinKeyDown);
    window.electron.ipcRenderer.on("ctrl-win-key-up", handleCtrlWinKeyUp);
    window.electron.ipcRenderer.on(
      "input-lock-changed",
      handleInputLockChanged,
    );
    window.addEventListener("output-playing-changed", handleOutputPlayingChanged);

    return () => {
      window.removeEventListener("output-playing-changed", handleOutputPlayingChanged);
      window.electron.ipcRenderer.removeListener(
        "ctrl-win-key-down",
        handleCtrlWinKeyDown,
      );
      window.electron.ipcRenderer.removeListener(
        "ctrl-win-key-up",
        handleCtrlWinKeyUp,
      );
      window.electron.ipcRenderer.removeListener(
        "input-lock-changed",
        handleInputLockChanged,
      );
    };
  }, []);

  // Help center dialog
  useEffect(() => {
    const dialog = helpCenterDialogRef.current;
    if (!dialog) return;
    if (helpCenterOpen) {
      window.electron?.getScreenSize?.().then((size) => {
        if (size?.width && size?.height) setScreenSize(size);
      });
      dialog.showModal();
    } else {
      dialog.close();
    }
  }, [helpCenterOpen]);

  useEffect(() => {
    if (!window.electron?.setNotchBounds || !notchContainerRef.current) return;
    const el = notchContainerRef.current;
    const send = () => {
      const r = el.getBoundingClientRect();
      window.electron.setNotchBounds({
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
      });
    };
    send();
    const ro = new ResizeObserver(send);
    ro.observe(el);
    return () => ro.disconnect();
  }, [position, isHovered, clickThroughEnabled]);

  useEffect(() => {
    const handleKeyDown = async (e) => {
      if (clickThroughEnabled) return;
      if (await isInputLocked()) {
        isHoldingRef.current = false;
        setIsCtrlWinHeld(false);
        return;
      }
      if (isHoldingRef.current) return;
      const both =
        (e.ctrlKey || e.metaKey) &&
        (e.key === "Meta" || e.key === "Win" || e.metaKey);
      if (!both) return;
      if (!(e.ctrlKey && (e.metaKey || e.key === "Meta" || e.key === "Win")))
        return;

      const canInterrupt = outputPlaying;
      if (!canInterrupt && Date.now() - lastCtrlWinAtRef.current < CTRL_WIN_COOLDOWN_MS) return;

      isHoldingRef.current = true;
      setIsCtrlWinHeld(true);
      if (ping1Audio.current) {
        ping1Audio.current.currentTime = 0;
        ping1Audio.current
          .play()
          .catch((err) => console.error("Error playing ping1:", err));
      }
    };

    const handleKeyUp = async (e) => {
      if (clickThroughEnabled) return;
      if (await isInputLocked()) {
        isHoldingRef.current = false;
        setIsCtrlWinHeld(false);
        return;
      }
      if (!(e.key === "Control" || e.key === "Meta" || e.key === "Win")) return;
      if (!isHoldingRef.current) return;

      isHoldingRef.current = false;
      lastCtrlWinAtRef.current = Date.now();
      setIsCtrlWinHeld(false);
      if (ping2Audio.current) {
        ping2Audio.current.currentTime = 0;
        ping2Audio.current
          .play()
          .catch((err) => console.error("Error playing ping2:", err));
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, [clickThroughEnabled, outputPlaying]);

  return (
    <div
      ref={notchContainerRef}
      className={`fixed ${containerSideClass} ${rowDirClass} flex items-center gap-2 mx-4 transition-all duration-300 ease-in-out`}
      style={verticalStyle}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* main notch button */}
      <div
        className={`w-15 h-15 p-2 border brandborderdark rounded-full flex items-center justify-center brandbgdark shrink-0 ${overlapMargin} z-10 relative`}
      >
        <img
          src={mascot}
          alt="Mascot"
          className="w-full h-full object-contain rounded-full"
          draggable="false"
        />
      </div>

      {/* expanded buttons container */}
      <div
        className={`flex bric items-center gap-2 overflow transition-all duration-300 ease-in-out border brandborderdark brandbgdark h-15 rounded-full ${padClass} relative z-0 ${
          isHovered ? "max-w-96 opacity-100" : "max-w-0 opacity-0"
        }`}
      >
        {!clickThroughEnabled && (
          <>
            <div
              className={`tooltip border ${tooltipDirClass}`}
              data-tip="Settings"
            >
              <button className="btn btn-sm btn-ghost text-lg brandbgdark text-white rounded-full shrink-0 transition-transform duration-200 hover:scale-110 border-0 hover:border-0">
                <i className="bi bi-gear-fill"></i>
              </button>
            </div>
            <div className={`tooltip ${tooltipDirClass}`} data-tip="Help">
              <button
                onClick={() => document.getElementById("helpmodal").showModal()}
                className="btn btn-sm btn-ghost text-lg brandbgdark text-white rounded-full shrink-0 transition-transform duration-200 hover:scale-110 border-0 hover:border-0"
              >
                <i className="bi bi-info-circle-fill"></i>
              </button>
            </div>
            <div className={`tooltip ${tooltipDirClass}`} data-tip="Move Theo">
              <button
                onClick={() => document.getElementById("movemodal").showModal()}
                className="btn btn-sm btn-ghost text-lg brandbgdark text-white rounded-full shrink-0 transition-transform duration-200 hover:scale-110 border-0 hover:border-0"
              >
                <i className="bi bi-arrows-move"></i>
              </button>
            </div>
          </>
        )}

        <div
          className={`tooltip ${tooltipDirClass}`}
          data-tip={
            clickThroughEnabled ? "Disable Human Input" : "Enable Human Input"
          }
        >
          <button
            onClick={() => {
              if (clickThroughEnabled) {
                window.electron?.setClickThrough?.(false);
                setClickThroughEnabled(false);
              } else {
                humanInputConfirmRef.current?.showModal();
              }
            }}
            className="btn btn-sm btn-ghost text-lg brandbgdark text-white rounded-full shrink-0 transition-transform duration-200 hover:scale-110 border-0 hover:border-0"
          >
            <i
              className={`bi ${clickThroughEnabled ? "bi-hand-index-thumb-fill" : "bi-hand-index-thumb"}`}
            ></i>
          </button>
        </div>

        <div className={`tooltip ${tooltipDirClass}`} data-tip="Quit">
          <button
            onClick={() => {
              if (window.electron?.ipcRenderer) {
                window.electron.ipcRenderer.send("quit-app");
              }
            }}
            className="btn btn-sm btn-ghost text-lg brandbgdark text-white rounded-full shrink-0 transition-transform duration-200 hover:scale-110 border-0 hover:border-0"
          >
            <i className="bi bi-escape"></i>
          </button>
        </div>
      </div>

      <dialog id="helpmodal" className="modal ">
        <div className="modal-box brandbg border-2 rounded-4xl p-8 border-black relative">
          <form method="dialog" className="absolute top-4 right-4">
            <button className="btn btn-ghost btn-sm p-0 w-8 h-8 min-h-0 border-0 hover:bg-transparent hover:border-0 hover:scale-100">
              <i className="bi bi-x-circle-fill text-2xl"></i>
            </button>
          </form>
          <h3 className="font-semibold text-3xl bric ">Hey there! I'm Theo.</h3>
          <p className="text-gray-500 inter  text-sm font-light mt-1.5">
            Press Ctrl + Win to start talking to Theo.
          </p>
          <div>
            <div className="flex items-center gap-4">
              <div className="flex-1">
                <h3 className="font-semibold text-xl bric mb-2 ">
                  For caregivers:
                </h3>
                <div className="brandbg border border-black rounded-2xl p-3.5">
                  <button
                    type="button"
                    className="text-left w-full cursor-pointer hover:underline focus:outline-none focus:underline"
                    onClick={() => setHelpCenterOpen(true)}
                  >
                    <p className="text-black inter  text-sm  mt-1.5">
                      Learn how you and your assisted individual can use Theo to
                      enhance your work.
                    </p>
                  </button>
                </div>
              </div>
              <img
                src={mascot}
                alt=""
                className="shrink-0 w-50 h-50 object-contain"
                draggable="false"
              />
            </div>
          </div>
        </div>
      </dialog>

      {/* Help center:*/}
      <dialog
        ref={helpCenterDialogRef}
        className="modal p-0 bg-black/50 border-0 flex items-center justify-center"
        onCancel={() => setHelpCenterOpen(false)}
        onClick={(e) => {
          if (e.target === helpCenterDialogRef.current)
            setHelpCenterOpen(false);
        }}
      >
        <div
          className="relative rounded-2xl overflow-hidden border-2 border-black bg-white shadow-2xl flex flex-col"
          style={(() => {
            const maxW = screenSize.width * 0.9;
            const maxH = screenSize.height * 0.9;
            const w = Math.min(maxW, maxH * (16 / 9));
            const h = w * (9 / 16);
            return { width: w, height: h };
          })()}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            aria-label="Close"
            className="absolute top-3 right-3 z-50 w-14 h-14 flex items-center justify-center rounded-full bg-black/80 hover:bg-black text-white border-2 border-white shadow-lg transition-colors"
            onClick={() => setHelpCenterOpen(false)}
          >
            <i className="bi bi-x text-3xl font-bold" />
          </button>
          <webview
            src="https://theodocs.super.site/theo-help-center"
            className="w-full flex-1 min-h-0"
            style={{ minHeight: 0 }}
          />
        </div>
      </dialog>

      <dialog ref={humanInputConfirmRef} className="modal" onCancel={() => {}}>
        <div className="modal-box brandbg border-2 rounded-4xl p-8 border-black relative">
          <form method="dialog" className="absolute top-4 right-4">
            <button
              type="button"
              className="btn btn-ghost btn-sm p-0 w-8 h-8 min-h-0 border-0 hover:bg-transparent hover:border-0 hover:scale-100"
              onClick={() => humanInputConfirmRef.current?.close()}
            >
              <i className="bi bi-x-circle-fill text-2xl"></i>
            </button>
          </form>
          <h3 className="font-semibold text-3xl bric">Are you sure?</h3>
          <p className="text-gray-500 inter text-sm font-light mt-1.5 ">
            Theo blocks human input by default for safety reasons. Disabling it
            will also disable Theo temporarily.
          </p>
          <div className="mt-6 flex gap-1 justify-end">
            <button
              type="button"
              className="btn btn-ghost border border-gray-400 rounded-full hover:bg-gray-100"
              onClick={() => humanInputConfirmRef.current?.close()}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn bric tracking-wide brandbgdark text-white border-0 rounded-full"
              onClick={() => {
                humanInputConfirmRef.current?.close();
                window.electron?.setClickThrough?.(true);
                setClickThroughEnabled(true);
              }}
            >
              Take control of your computer
            </button>
          </div>
        </div>
      </dialog>

      <dialog id="movemodal" className="modal">
        <div className="modal-box brandbg text-center border-2 rounded-4xl p-8 border-black relative overflow-visible">
          <img
            src={mascot}
            alt=""
            draggable="false"
            className="absolute -top-16 left-1/2 -translate-x-1/2 w-30 h-30 object-contain"
          />

          <form method="dialog" className="absolute top-4 right-4">
            <button className="btn btn-ghost btn-sm p-0 w-8 h-8 min-h-0 border-0 hover:bg-transparent">
              <i className="bi bi-x-circle-fill text-2xl"></i>
            </button>
          </form>

          <h3 className="font-semibold text-3xl bric mt-5">Modal Position</h3>
          <p className="text-gray-500 inter text-sm font-light mt-1.5">
            Select a corner of your screen to have Theo live!
          </p>
          <div id="moveButtons" className="mt-5 flex flex-col gap-3">
            <button
              onClick={() => setPosition("bottom-left")}
              className={moveBtnClass("bottom-left")}
            >
              <span>Bottom-Left</span>
              <span className="text-2xl">
                <i className="bi bi-arrow-down-left"></i>
              </span>
            </button>
            <button
              onClick={() => setPosition("top-left")}
              className={moveBtnClass("top-left")}
            >
              <span>Top-Left</span>
              <span className="text-2xl">
                <i className="bi bi-arrow-up-left"></i>
              </span>
            </button>
            <button
              onClick={() => setPosition("bottom-right")}
              className={moveBtnClass("bottom-right")}
            >
              <span>Bottom-Right</span>
              <span className="text-2xl">
                <i className="bi bi-arrow-down-right"></i>
              </span>
            </button>
            <button
              onClick={() => setPosition("top-right")}
              className={moveBtnClass("top-right")}
            >
              <span>Top-Right</span>
              <span className="text-2xl">
                <i className="bi bi-arrow-up-right"></i>
              </span>
            </button>
          </div>
        </div>
      </dialog>

      <div
        className={`fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none transition-opacity duration-300 ease-in-out ${
          isCtrlWinHeld ? "opacity-100" : "opacity-0"
        }`}
      >
        <div className="brandbgdark text-white border-2 brandborderdark rounded-2xl px-6 py-4 flex items-center gap-3 shadow-lg">
          <div className="w-3 h-3 bg-red-500 rounded-full animate-pulse"></div>
          <span className="bric text-sm font-medium">Speaking...</span>
        </div>
      </div>
    </div>
  );
}

export default Notch;

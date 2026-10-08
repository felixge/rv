import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { WorkerPoolContextProvider } from "@pierre/diffs/react";
import DiffWorker from "@pierre/diffs/worker/worker.js?worker";
import "./lib/backgroundFrames";
import { api } from "./lib/api";
import { Review } from "./review/Review";
import type { Info, SavedState } from "./types";
import "./style.css";

const workerPoolOptions = { workerFactory: () => new DiffWorker(), poolSize: 2 };
const highlighterOptions = { theme: "light-plus" as const };

function App() {
  const [loaded, setLoaded] = useState<{ info: Info; state: SavedState }>();
  const [error, setError] = useState("");
  const infoRequest = useRef(0);
  useEffect(() => {
    Promise.all([
      api<Info>("info"),
      // An unavailable cache still opens the review; saving errors surface later.
      api<SavedState>("state").catch(() => ({})),
    ])
      .then(([info, state]) => setLoaded({ info, state }))
      .catch((e) => setError(e.message));
  }, []);
  if (!loaded)
    return (
      <div className="startup">
        <span className="brand-mark">r/</span>
        <h1>rv</h1>
        <p role="status">{error || "Opening your repository…"}</p>
        {error && <button onClick={() => location.reload()}>Try again</button>}
      </div>
    );
  return (
    <Review
      info={loaded.info}
      state={loaded.state}
      refreshInfo={async () => {
        const request = ++infoRequest.current;
        const info = await api<Info>("info", { refresh: crypto.randomUUID() });
        if (request === infoRequest.current)
          setLoaded((current) => current ? { ...current, info } : current);
        return info;
      }}
    />
  );
}


createRoot(document.getElementById("root")!).render(
  <WorkerPoolContextProvider
    poolOptions={workerPoolOptions}
    highlighterOptions={highlighterOptions}
  >
    <App />
  </WorkerPoolContextProvider>,
);

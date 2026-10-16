import { createSignal, Show } from "solid-js";
import { render } from "solid-js/web";
import "./lib/backgroundFrames";
import { api } from "./lib/api";
import { Review } from "./review/Review";
import type { Info, SavedState } from "./types";
import "./style.css";

function App() {
  const [loaded, setLoaded] = createSignal<{ info: Info; state: SavedState }>();
  const [error, setError] = createSignal("");
  let infoRequest = 0;
  Promise.all([
    api<Info>("info"),
    // An unavailable cache still opens the review; saving errors surface later.
    api<SavedState>("state").catch(() => ({})),
  ])
    .then(([info, state]) => setLoaded({ info, state }))
    .catch((e) => setError(e.message));
  return (
    <Show
      when={loaded()}
      fallback={
        <div class="startup">
          <span class="brand-mark">r/</span>
          <h1>rv</h1>
          <p role="status">{error() || "Opening your repository…"}</p>
          <Show when={error()}>
            <button onClick={() => location.reload()}>Try again</button>
          </Show>
        </div>
      }
    >
      {(value) => (
        <Review
          info={value().info}
          state={value().state}
          refreshInfo={async () => {
            const request = ++infoRequest;
            const info = await api<Info>("info", { refresh: crypto.randomUUID() });
            if (request === infoRequest)
              setLoaded((current) => current ? { ...current, info } : current);
            return info;
          }}
        />
      )}
    </Show>
  );
}

render(() => <App />, document.getElementById("root")!);

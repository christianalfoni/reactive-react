import "./App.css";
import { createState, createEffect, createRef } from "./lib/reactive";

function App() {
  const state = createState({ count: 0 });

  return () => <h1 onClick={() => state.count++}>Hello world {state.count}</h1>;
}

export default App;

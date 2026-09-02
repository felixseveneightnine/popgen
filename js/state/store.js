// A small "Redux-lite" store: one plain-data state object, mutated in place by
// a recipe function rather than rebuilt immutably (this app's data is small --
// a handful of waves/spawns -- so a structuredClone snapshot per undoable
// commit is cheap, and it avoids rewriting every mutation site into
// {...spread}-style immutable updates for marginal benefit at this scale).
//
// commit(recipe, opts):
//   - opts.undoable (default true): snapshot the state onto the history stack
//     BEFORE running recipe, and clear the redo stack. Pass false for
//     navigation-only changes (selecting a tab/wave/slot) so undo never yanks
//     the user to a different view.
//   - opts.affects (default []): a list of render-function names this change
//     needs (e.g. ['waveSpawns', 'robotList']). Subscribers decide what that
//     means; the store just forwards it.
//
// Subscribers are notified synchronously on every commit/undo/redo with the
// affects list (undo/redo pass ['all'], since a whole different snapshot can
// change everything). Batching multiple commits into one render pass is the
// subscriber's job, not the store's.
export function createStore(initialState, { historyCap = 50 } = {}) {
  let state = initialState;
  const listeners = new Set();
  let history = [];
  let future = [];

  function getState() {
    return state;
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function notify(affects) {
    listeners.forEach((listener) => listener(affects, state));
  }

  function commit(recipe, opts = {}) {
    const undoable = opts.undoable !== false;
    const affects = opts.affects || [];

    if (undoable) {
      history.push(structuredClone(state));
      if (history.length > historyCap) history.shift();
      future = [];
    }

    recipe(state);
    notify(affects);
  }

  function undo() {
    if (!history.length) return false;
    future.push(structuredClone(state));
    state = history.pop();
    notify(["all"]);
    return true;
  }

  function redo() {
    if (!future.length) return false;
    history.push(structuredClone(state));
    state = future.pop();
    notify(["all"]);
    return true;
  }

  function canUndo() {
    return history.length > 0;
  }

  function canRedo() {
    return future.length > 0;
  }

  return { getState, subscribe, commit, undo, redo, canUndo, canRedo };
}

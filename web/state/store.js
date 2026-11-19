/**
 * Lightweight reactive state store mirroring nimueblue's { get, set, subscribe, select }.
 */

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

/**
 * Create a reactive store container with shallow merge updates and slice subscriptions.
 * @template T
 * @param {T} initialState
 * @returns {{
 *   get: () => T,
 *   set: (partialOrUpdater: Partial<T> | ((prev: T) => Partial<T> | T)) => T,
 *   subscribe: (listener: (state: T, prevState: T) => void) => () => void,
 *   select: <S>(selector: (state: T) => S, listener: (nextSlice: S, prevSlice: S) => void, isEqual?: (a: S, b: S) => boolean) => () => void,
 * }}
 */
export function createStore(initialState) {
  let state = initialState;
  const listeners = new Set();

  function get() {
    return state;
  }

  function set(partialOrUpdater) {
    const update = typeof partialOrUpdater === 'function' ? partialOrUpdater(state) : partialOrUpdater;
    if (update === undefined || update === null || Object.is(update, state)) {
      return state;
    }

    let nextState;
    if (isPlainObject(state) && isPlainObject(update)) {
      const keys = Object.keys(update);
      const changed = keys.some((key) => !Object.is(state[key], update[key]));
      if (!changed) {
        return state;
      }
      nextState = { ...state, ...update };
    } else {
      nextState = update;
    }

    const prevState = state;
    state = nextState;
    for (const listener of [...listeners]) {
      listener(state, prevState);
    }
    return state;
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function select(selector, listener, isEqual = Object.is) {
    let currentSlice = selector(state);
    return subscribe((nextState) => {
      const nextSlice = selector(nextState);
      if (!isEqual(currentSlice, nextSlice)) {
        const prevSlice = currentSlice;
        currentSlice = nextSlice;
        listener(nextSlice, prevSlice);
      }
    });
  }

  return { get, set, subscribe, select };
}

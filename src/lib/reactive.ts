import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";

// Shallow comparison utility
function shallowEqual(objA: any, objB: any): boolean {
  if (objA === objB) return true;
  if (typeof objA !== "object" || objA === null || typeof objB !== "object" || objB === null) {
    return false;
  }

  const keysA = Object.keys(objA);
  const keysB = Object.keys(objB);

  if (keysA.length !== keysB.length) return false;

  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(objB, key) || objA[key] !== objB[key]) {
      return false;
    }
  }

  return true;
}

// Dependency tracking system
let activeEffect: (() => void) | null = null;
const targetMap = new WeakMap<object, Map<string | symbol, Set<() => void>>>();

// Track dependencies for cleanup
const effectDepsMap = new WeakMap<() => void, Set<{ target: object; key: string | symbol }>>();

// Cache for reactive proxies to prevent memory leaks with nested objects
const proxyCache = new WeakMap<object, any>();

// Track parent references for arrays so we can trigger updates on the parent property
const proxyParentMap = new WeakMap<object, { parent: object; key: string | symbol }>();

// Update batching
let pendingEffects = new Set<() => void>();
let isFlushPending = false;

function queueEffect(effect: () => void) {
  pendingEffects.add(effect);
  if (!isFlushPending) {
    isFlushPending = true;
    queueMicrotask(flushEffects);
  }
}

function flushEffects() {
  isFlushPending = false;
  const effects = [...pendingEffects];
  pendingEffects.clear();
  effects.forEach((effect) => effect());
}

// Component instance tracking for createEffect
type EffectCleanup = void | (() => void);
type ComponentEffects = Array<() => EffectCleanup>;
let activeComponentEffects: ComponentEffects | null = null;

// Component instance tracking for createRef
type RefCallback<T> = ((instance: T | null) => void) & { current: T | null };
type ComponentRefs = Array<RefCallback<any>>;
let activeComponentRefs: ComponentRefs | null = null;

function track(target: object, key: string | symbol) {
  if (!activeEffect) return;

  let depsMap = targetMap.get(target);
  if (!depsMap) {
    depsMap = new Map();
    targetMap.set(target, depsMap);
  }

  let deps = depsMap.get(key);
  if (!deps) {
    deps = new Set();
    depsMap.set(key, deps);
  }

  deps.add(activeEffect);

  // Track this dependency for cleanup
  let effectDeps = effectDepsMap.get(activeEffect);
  if (!effectDeps) {
    effectDeps = new Set();
    effectDepsMap.set(activeEffect, effectDeps);
  }
  effectDeps.add({ target, key });
}

function trigger(target: object, key: string | symbol) {
  const depsMap = targetMap.get(target);
  if (!depsMap) return;

  const deps = depsMap.get(key);
  if (!deps) return;

  // Queue effects for batched execution
  deps.forEach((effect) => queueEffect(effect));
}

// Array methods that mutate the array
const arrayInstrumentations: Record<string, Function> = {};

['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse'].forEach(method => {
  arrayInstrumentations[method] = function(this: any[], ...args: any[]) {
    // Pause tracking during method execution
    const prevEffect = activeEffect;
    activeEffect = null;

    const result = Array.prototype[method as keyof Array<any>].apply(this, args);

    // Restore tracking
    activeEffect = prevEffect;

    // Trigger updates on the array itself and length property
    trigger(this, method);
    trigger(this, 'length');

    // Also trigger on the parent property that holds this array
    const parentInfo = proxyParentMap.get(this);
    if (parentInfo) {
      trigger(parentInfo.parent, parentInfo.key);
    }

    return result;
  };
});

// Create a reactive proxy for an object
export function createState<T extends object>(obj: T, parent?: object, key?: string | symbol): T {
  // Return cached proxy if it exists
  const existingProxy = proxyCache.get(obj);
  if (existingProxy) {
    return existingProxy;
  }

  const isArray = Array.isArray(obj);

  const proxy = new Proxy(obj, {
    get(target, key, receiver) {
      // Use instrumented array methods
      if (isArray && typeof key === 'string' && key in arrayInstrumentations) {
        return arrayInstrumentations[key];
      }

      const value = Reflect.get(target, key, receiver);
      track(target, key);

      // Recursively make nested objects and arrays reactive
      if (value !== null && typeof value === "object") {
        return createState(value, target, key);
      }

      return value;
    },

    set(target, key, value, receiver) {
      const oldValue = Reflect.get(target, key, receiver);
      const result = Reflect.set(target, key, value, receiver);

      // Only trigger if the value actually changed
      if (oldValue !== value) {
        trigger(target, key);
      }

      return result;
    },
  });

  // Cache the proxy
  proxyCache.set(obj, proxy);

  // Store parent reference for arrays
  if (parent && key !== undefined) {
    proxyParentMap.set(proxy, { parent, key });
  }

  return proxy;
}

// Effect function that tracks dependencies and reruns on changes
export function effect(fn: () => void) {
  const execute = () => {
    // Clean up old dependencies before re-running
    cleanup();

    activeEffect = execute;
    try {
      fn();
    } finally {
      activeEffect = null;
    }
  };

  const cleanup = () => {
    // Remove this effect from all its dependencies
    const deps = effectDepsMap.get(execute);
    if (deps) {
      deps.forEach(({ target, key }) => {
        const depsMap = targetMap.get(target);
        if (depsMap) {
          const targetDeps = depsMap.get(key);
          if (targetDeps) {
            targetDeps.delete(execute);
          }
        }
      });
      // Clear the dependency tracking for this effect
      deps.clear();
    }
  };

  execute();

  // Return cleanup function
  return () => {
    cleanup();
    // Also remove the effect's dependency map entirely
    effectDepsMap.delete(execute);
  };
}

// Create a reactive effect within a component setup
export function createEffect(fn: () => EffectCleanup) {
  if (activeComponentEffects === null) {
    throw new Error("createEffect can only be called inside a reactive component setup");
  }

  // Create a reactive wrapper for the effect
  const reactiveEffectFn = () => {
    let cleanup: EffectCleanup;
    const trackedDeps = new Set<{ target: object; key: string | symbol }>();

    // Effect function that will be called when dependencies change
    const effectRunner = () => {
      // Clean up previous run
      if (cleanup && typeof cleanup === "function") {
        cleanup();
      }
      cleanup = fn();
    };

    // Track dependencies on first run
    const prevEffect = activeEffect;
    activeEffect = effectRunner;

    try {
      // Run the effect once to establish what it accesses
      cleanup = fn();

      // Capture tracked dependencies
      const deps = effectDepsMap.get(effectRunner);
      if (deps) {
        deps.forEach(dep => trackedDeps.add(dep));
      }
    } finally {
      activeEffect = prevEffect;
    }

    // Subscribe to the tracked dependencies
    trackedDeps.forEach(({ target, key }) => {
      let depsMap = targetMap.get(target);
      if (!depsMap) {
        depsMap = new Map();
        targetMap.set(target, depsMap);
      }
      let targetDeps = depsMap.get(key);
      if (!targetDeps) {
        targetDeps = new Set();
        depsMap.set(key, targetDeps);
      }
      targetDeps.add(effectRunner);
    });

    // Return cleanup that unsubscribes and cleans up the effect
    return () => {
      // Run effect cleanup
      if (cleanup && typeof cleanup === "function") {
        cleanup();
      }

      // Unsubscribe from all dependencies
      trackedDeps.forEach(({ target, key }) => {
        const depsMap = targetMap.get(target);
        if (depsMap) {
          const targetDeps = depsMap.get(key);
          if (targetDeps) {
            targetDeps.delete(effectRunner);
          }
        }
      });

      // Clean up tracking map
      effectDepsMap.delete(effectRunner);
    };
  };

  // Register this effect with the active component
  activeComponentEffects.push(reactiveEffectFn);
}

// Create a reactive ref within a component setup
export function createRef<T = any>(): RefCallback<T> {
  if (activeComponentRefs === null) {
    throw new Error("createRef can only be called inside a reactive component setup");
  }

  // Store the actual ref value (not proxied to avoid method binding issues)
  let currentValue: T | null = null;

  // Create a dummy target object for tracking the "current" property access
  const trackingTarget = {};
  const CURRENT_KEY = "current";

  // Create a callback ref function
  const refCallback = ((instance: T | null) => {
    currentValue = instance;
    // Trigger updates when ref changes
    trigger(trackingTarget, CURRENT_KEY);
  }) as RefCallback<T>;

  // Attach the reactive current property to the callback
  Object.defineProperty(refCallback, "current", {
    get() {
      // Track access to the ref
      track(trackingTarget, CURRENT_KEY);
      return currentValue;
    },
    set(value: T | null) {
      currentValue = value;
      trigger(trackingTarget, CURRENT_KEY);
    },
    enumerable: true,
    configurable: true,
  });

  // Register this ref with the active component
  activeComponentRefs.push(refCallback);

  return refCallback;
}

// The reactive function that creates reactive components
export function reactive<P extends object>(
  setup: (props: P) => () => React.ReactElement
): React.ComponentType<P> {
  return (props: P) => {
    const prevPropsRef = useRef<P | null>(null);
    const reactivePropsRef = useRef<P | null>(null);
    const componentRef = useRef<(() => React.ReactElement) | null>(null);
    const effectsRef = useRef<ComponentEffects>([]);

    // For useSyncExternalStore integration
    const versionRef = useRef(0);
    const onStoreChangeRef = useRef<(() => void) | null>(null);
    const disposeTrackingRef = useRef<(() => void) | null>(null);

    // Initialize on first render
    if (componentRef.current === null) {
      // Set up the effects array for this component instance
      const componentEffects: ComponentEffects = [];
      effectsRef.current = componentEffects;

      // Set up the refs array for this component instance
      const componentRefs: ComponentRefs = [];

      // Make effects and refs arrays active during setup
      activeComponentEffects = componentEffects;
      activeComponentRefs = componentRefs;
      try {
        reactivePropsRef.current = createState({ ...props });
        componentRef.current = setup(reactivePropsRef.current);
      } finally {
        activeComponentEffects = null;
        activeComponentRefs = null;
      }
    }

    // Update reactive props when props change (with shallow comparison)
    useLayoutEffect(() => {
      if (prevPropsRef.current !== null && !shallowEqual(prevPropsRef.current, props)) {
        // Update each prop in the reactive props object
        Object.keys(props).forEach((key) => {
          const typedKey = key as keyof P;
          if (reactivePropsRef.current) {
            (reactivePropsRef.current as any)[typedKey] = props[typedKey];
          }
        });

        // Delete props that no longer exist
        if (reactivePropsRef.current) {
          Object.keys(reactivePropsRef.current).forEach((key) => {
            if (!(key in props)) {
              delete (reactivePropsRef.current as any)[key];
            }
          });
        }
      }
      prevPropsRef.current = { ...props };
    });

    // Run all createEffect effects
    useEffect(() => {
      const cleanups: Array<(() => void) | void> = [];

      // Execute each registered effect
      effectsRef.current.forEach((effectFn) => {
        const cleanup = effectFn();
        cleanups.push(cleanup);
      });

      // Return cleanup function that runs all effect cleanups
      return () => {
        cleanups.forEach((cleanup) => {
          if (cleanup) {
            cleanup();
          }
        });
      };
    }, []);

    // Subscribe function for useSyncExternalStore
    const subscribe = (onStoreChange: () => void) => {
      onStoreChangeRef.current = onStoreChange;

      // Create effect function that will notify React when dependencies change
      const notifyChange = () => {
        versionRef.current++;
        onStoreChangeRef.current?.();
      };

      // Set up tracking using effect()
      // We track once initially, and whenever dependencies change, we call notifyChange
      let isInitialRun = true;
      const dispose = effect(() => {
        // Call render function to track dependencies
        componentRef.current!();

        if (!isInitialRun) {
          // On subsequent runs (when dependencies change), notify React
          notifyChange();
        }
        isInitialRun = false;
      });

      disposeTrackingRef.current = dispose;

      return () => {
        dispose();
        onStoreChangeRef.current = null;
      };
    };

    // Get snapshot function for useSyncExternalStore
    const getSnapshot = () => {
      return versionRef.current;
    };

    // Use useSyncExternalStore to properly integrate with React
    useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

    // Run all createEffect effects
    useEffect(() => {
      const cleanups: Array<(() => void) | void> = [];

      // Execute each registered effect
      effectsRef.current.forEach((effectFn) => {
        const cleanup = effectFn();
        cleanups.push(cleanup);
      });

      // Return cleanup function that runs all effect cleanups
      return () => {
        cleanups.forEach((cleanup) => {
          if (cleanup) {
            cleanup();
          }
        });
      };
    }, []);

    // Render normally - tracking happens in subscribe()
    const result = componentRef.current!();

    return result;
  };
}

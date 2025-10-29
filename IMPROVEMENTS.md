# Reactive React API - Improvements & Issues

## 📊 Status Summary

**Last Updated**: 2025-10-29

### Critical Issues: 5/5 ✅ FIXED
- ✅ Memory leak with nested objects
- ✅ Arrays not reactive
- ✅ Duplicate tracking system
- ✅ Missing update batching
- ✅ Props deletion handling

### Remaining Issues
- ⚠️ 5 Core Features Missing
- 😕 6 API Design Issues
- 🐛 5 Edge Cases
- 📚 Documentation Gaps

---

## 🚨 Critical Problems

### 1. ✅ Memory Leak with Nested Objects [FIXED]
**Location**: `src/lib/reactive.ts:32-33, 124-127`

```typescript
// This creates a NEW proxy every time you access nested object
if (value !== null && typeof value === "object" && !Array.isArray(value)) {
  return createState(value);  // ⚠️ NEW proxy each time!
}
```

**Problem**: Every access to `state.user.name` creates a fresh proxy. These accumulate in `targetMap` and never get cleaned up. Reactivity breaks because tracking happens on different proxy instances.

**Fix applied**: Added `proxyCache` WeakMap to cache and reuse proxy instances. Nested objects now return the same proxy on repeated access.

---

### 2. ✅ Arrays Not Reactive [FIXED]
**Location**: `src/lib/reactive.ts:100-120, 135-137`

```typescript
!Array.isArray(value)  // ⚠️ Arrays excluded from reactivity
```

**Problem**: `state.todos.push(item)` won't trigger updates. Array mutations are invisible to the reactive system.

**Fix applied**: Implemented instrumented array methods (`push`, `pop`, `shift`, `unshift`, `splice`, `sort`, `reverse`) that trigger reactive updates. Arrays are now fully reactive.

---

### 3. ✅ Duplicate Tracking System [FIXED]
**Location**: `src/lib/reactive.ts:292, 360-409`

You're setting up `activeEffect` in TWO places:
- Once in a `useEffect` that wraps `forceUpdate` in an `effect()`
- Again during render by directly setting `activeEffect = () => forceUpdate({})`

**Problem**: Every property access gets tracked twice in different ways. This is confusing and potentially buggy.

**Fix applied**: Removed duplicate useEffect. Now uses single stable `renderEffectRef` for tracking with proper dependency cleanup before each render and on unmount.

---

### 4. ✅ Missing Update Batching [FIXED]
**Location**: `src/lib/reactive.ts:34-51, 89-98`

```typescript
state.count++;
state.name = "foo";
state.age = 30;
// ⚠️ This triggers 3 separate re-renders!
```

**Problem**: No queueing/batching mechanism. React 18 has automatic batching for event handlers, but your reactive system triggers immediately on each mutation.

**Fix applied**: Implemented `queueEffect` and `flushEffects` using `queueMicrotask`. Multiple state changes now batch into a single re-render automatically.

---

## ⚠️ Missing Core Features

### 5. No Computed Values

Users coming from Vue/Solid/Mobx will expect:

```typescript
const doubled = computed(() => state.count * 2);
```

This is a fundamental reactive primitive that caches derived values and only recomputes when dependencies change.

---

### 6. ✅ No Props Deletion Handling [FIXED]
**Location**: `src/lib/reactive.ts:325-332`

```typescript
Object.keys(props).forEach((key) => {
  reactivePropsRef.current[key] = props[key];
});
// ⚠️ What if a prop was removed? It stays in reactivePropsRef!
```

**Problem**: If a parent component stops passing a prop, it remains in the reactive props object with its old value.

**Fix applied**: Added code to delete keys from reactivePropsRef that no longer exist in new props after updating.

---

### 7. No Stop/Pause Mechanism

**Problem**: Once an effect is created, you can't easily stop it from inside the component. The `effect()` function returns a disposer, but `createEffect()` doesn't expose it.

**Use case**: Pausing expensive effects when component is hidden or stopping polling when conditions change.

---

### 8. No Async Effect Support

What happens here?

```typescript
createEffect(async () => {
  const data = await fetchData();
  state.data = data;
});
```

**Problem**: Unclear behavior with async functions. Should it track dependencies before the first await? After? Handle cleanup for in-flight requests?

**Fix needed**: Document behavior or provide `createAsyncEffect` with proper cleanup/cancellation

---

### 9. No TypeScript Type Safety for Proxies

```typescript
const state = createState({ user: { name: "John" } });
state.user.name; // TypeScript sees this as correct
state.user.age;  // ⚠️ But this also type-checks even though age doesn't exist!
```

**Problem**: The proxy doesn't preserve exact types. Users can access non-existent properties without type errors.

**Fix needed**: Better TypeScript generics or branded types

---

## 😕 Confusing API Design

### 10. Setup Function Pattern

```typescript
const Counter = reactive((props) => {
  // setup
  return () => <div>...</div>;  // ⚠️ Why return a function?
});
```

**Problem**: This is unusual for React developers. Why not just return JSX directly like normal components?

**Alternative**:
```typescript
const Counter = reactive((props) => {
  // setup
  return <div>...</div>;  // Regular JSX
});
```

---

### 11. effect() vs createEffect() Naming

Two similar functions with different contexts:
- `effect()` - standalone, returns disposer
- `createEffect()` - component-bound, returns nothing

**Problem**: Naming doesn't clearly communicate the difference.

**Alternative names**:
- `watchEffect()` and `createComponentEffect()`
- `effect()` and `useReactiveEffect()`
- `autorun()` and `createEffect()`

---

### 12. createRef() vs React's useRef

**Problem**: You're introducing a new ref API alongside React's existing one. When should users use which? The dual nature (callback ref + `.current`) is clever but confusing.

**Questions**:
- Can you use `useRef` in reactive components?
- When should you use `createRef` vs `useRef`?
- Why is `createRef` reactive but `useRef` isn't?

---

### 13. Props Are Magically Reactive

```typescript
reactive((props) => {
  createEffect(() => {
    console.log(props.count);  // ⚠️ This tracks props changes!
  });
});
```

**Problem**: Not obvious that props are reactive. Could surprise users who don't read documentation carefully.

**Fix needed**: Make this explicit in naming or documentation

---

### 14. Global State Not Clear

Can you do this?

```typescript
const globalState = createState({ count: 0 });

const Counter = reactive(() => {
  return () => <div>{globalState.count}</div>;
});
```

**Problem**: Probably yes, but it's not documented or clear how to share state between components.

**Questions**:
- How do you create shared/global state?
- Can you export reactive state from a module?
- What about state management patterns (stores, contexts)?

---

### 15. Plugin Auto-Transform is Invisible
**Location**: `src/lib/plugin.ts`

The Vite plugin automatically wraps components that return functions. This magic could be confusing:

```typescript
// I wrote this:
function Counter(props) {
  return () => <div>...</div>;
}

// But at runtime it becomes:
const Counter = reactive((props) => {
  return () => <div>...</div>;
});
```

**Problems**:
- Hidden magic transformation
- Works differently with plugin vs manual `reactive()` calls
- Hard to debug when transformation doesn't happen
- Plugin only checks for components starting with uppercase letter

---

## 🐛 Additional Edge Cases

### 16. No Handling for Circular References

What happens with:

```typescript
const state = createState({ parent: null, child: null });
state.parent = state.child;
state.child.parent = state;
```

---

### 17. WeakMap Limitations

`targetMap` uses WeakMap, which requires object keys. Primitive values in objects won't track properly in certain edge cases.

---

### 18. No Error Boundaries Integration

If an effect throws an error, what happens? Does it break all reactivity? Should there be error handling?

---

### 19. React Strict Mode Behavior

The App.tsx mentions effects run twice in Strict Mode, but this could be confusing for users not familiar with React 19's behavior.

---

### 20. No Dev Tools

Missing developer tools for:
- Visualizing reactive dependencies
- Tracking which effects are running
- Debugging why re-renders happen
- Performance profiling

---

## 🎯 Priority Recommendations

### ✅ Must Fix Immediately (Blocking Issues) - **COMPLETED**
1. ✅ Fix nested object proxy caching (prevents memory leaks) - **FIXED**
2. ✅ Add array reactivity - **FIXED**
3. ✅ Clarify/fix the double tracking setup - **FIXED**
4. ✅ Add update batching - **FIXED**
5. ✅ Handle prop deletions - **FIXED**

### Should Add for Completeness (Before Public Release)
5. ⚠️ Computed values
6. ⚠️ Better effect cleanup control
7. ⚠️ Type safety improvements
8. ⚠️ Document/clarify the setup function pattern
9. ⚠️ Async effect handling

### Nice to Have (Polish)
11. 💡 Better naming/documentation
12. 💡 Global state patterns and examples
13. 💡 Dev tools integration
14. 💡 Error boundaries
15. 💡 Performance optimizations
16. 💡 Test coverage

---

## 📚 Documentation Gaps

1. No README explaining the API
2. No migration guide from other reactive libraries
3. No examples of common patterns
4. No TypeScript usage guide
5. No performance guidelines
6. No comparison with other solutions (Vue Composition API, Solid, Preact Signals, etc.)

---

## 💭 API Design Questions to Consider

1. **Should effects run on mount?** Currently they do, but Vue's `watchEffect` has options for this
2. **Should there be a way to watch specific values?** Like `watch(() => state.count, (newVal, oldVal) => {})`
3. **Should reactive state be deeply immutable?** Or allow direct mutation as designed?
4. **How should this integrate with React context?** Can reactive state be provided via context?
5. **What about React 19 features?** How does this work with use(), transitions, etc.?

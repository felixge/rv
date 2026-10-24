import { createMemo, createRenderEffect, createRoot, getOwner, on, onCleanup, onMount, untrack, type JSX } from "solid-js";
import { insert } from "solid-js/web";
import {
  areOptionsEqual,
  CodeView as Viewer,
  CUSTOM_HEADER_SLOT_ID,
  type CodeViewItem,
  type CodeViewLineSelection,
  type CodeViewOptions,
  type CodeViewRenderedItem,
  type CodeViewSlotSnapshot,
  type DiffLineAnnotation,
} from "@pierre/diffs";
import { getOrCreateWorkerPoolSingleton } from "@pierre/diffs/worker";
import DiffWorker from "@pierre/diffs/worker/worker.js?worker";

export type CodeViewInstance<A> = Viewer<A, undefined>;

const workerPool = getOrCreateWorkerPoolSingleton({
  poolOptions: { workerFactory: () => new DiffWorker(), poolSize: 2 },
  highlighterOptions: { theme: "light-plus" },
});

const noop = () => undefined;

// Pierre's virtualized CodeView with controlled items and line selection.
// Headers and annotations render as Solid content into the slots of the
// files currently in the virtual window.
export function CodeView<A>(props: {
  class: string;
  items: CodeViewItem<A>[];
  options: CodeViewOptions<A, undefined>;
  selectedLines: CodeViewLineSelection | null;
  onSelectedLinesChange: (selection: CodeViewLineSelection | null) => void;
  onScroll?: (scrollTop: number, viewer: CodeViewInstance<A>) => void;
  onRenderedItemsChange?: (ids: string[]) => void;
  renderCustomHeader?: (item: CodeViewItem<A>) => JSX.Element;
  renderAnnotation: (annotation: DiffLineAnnotation<A>) => JSX.Element;
  // Receives the viewer once mounted, and undefined when it unmounts.
  ref: (viewer: CodeViewInstance<A> | undefined) => void;
}) {
  let container!: HTMLDivElement;
  let disposed = false;
  onCleanup(() => { disposed = true; });
  const owner = getOwner();
  const hasCustomHeader = untrack(() => !!props.renderCustomHeader);
  const managedOptions = createMemo<CodeViewOptions<A, undefined>>(() => ({
    ...props.options,
    controlledSelection: true,
    onSelectedLinesChange: (selection) => props.onSelectedLinesChange(selection),
    ...(hasCustomHeader ? { renderCustomHeader: noop } : {}),
  }));

  // Slot content of each rendered file element, keyed by the item it shows.
  const slots = new Map<HTMLElement, { key: string; dispose: () => void }>();
  const slotKey = (item: CodeViewRenderedItem<A, undefined>) =>
    `${item.id}:${item.version}:${item.type}`;
  function renderSlots({ item, element, instance }: CodeViewRenderedItem<A, undefined>) {
    return createRoot((dispose) => {
      const nodes: HTMLElement[] = [];
      const slot = (name: string, content: () => JSX.Element) => {
        const node = document.createElement("div");
        node.slot = name;
        insert(node, content);
        element.append(node);
        nodes.push(node);
      };
      if (props.renderCustomHeader)
        slot(CUSTOM_HEADER_SLOT_ID, () => props.renderCustomHeader!(item));
      for (const annotation of item.annotations || [])
        slot(instance.getAnnotationSlotName(annotation), () =>
          props.renderAnnotation(annotation as DiffLineAnnotation<A>));
      return () => {
        dispose();
        for (const node of nodes) node.remove();
      };
    }, owner);
  }
  // CodeView pools a file element for reuse once its slot content is removed.
  function onSnapshotChange(snapshot: CodeViewSlotSnapshot<A, undefined> | undefined) {
    const rendered = new Map(snapshot?.items?.map((item) => [item.element, item]));
    // Loading can update items. Never update the viewer during its own render.
    const ids = [...rendered.values()].map((item) => item.id);
    queueMicrotask(() => { if (!disposed) props.onRenderedItemsChange?.(ids); });
    for (const [element, slot] of slots) {
      const item = rendered.get(element);
      if (item && slotKey(item) === slot.key) continue;
      slot.dispose();
      slots.delete(element);
    }
    for (const [element, item] of rendered) {
      if (!slots.has(element))
        slots.set(element, { key: slotKey(item), dispose: renderSlots(item) });
    }
  }

  onMount(() => {
    const viewer = new Viewer<A, undefined>(untrack(managedOptions), workerPool, true);
    viewer.setup(container);
    viewer.setSlotCoordinator({
      hasHeaderRenderers: hasCustomHeader,
      hasAnnotationRenderer: true,
      hasGutterRenderer: false,
      onSnapshotChange,
    });
    let options: CodeViewOptions<A, undefined> | undefined;
    let items: CodeViewItem<A>[] | undefined;
    // A render effect, so the viewer has its items before the parent's
    // effects scroll to them.
    createRenderEffect(on(
      [managedOptions, () => props.items, () => props.selectedLines],
      ([nextOptions, nextItems, selectedLines]) => {
        let render = false;
        if (!areOptionsEqual(nextOptions, options)) {
          options = nextOptions;
          viewer.setOptions(nextOptions);
          render = true;
        }
        if (nextItems !== items) {
          items = nextItems;
          viewer.setItems(nextItems);
          render = true;
        }
        viewer.setSelectedLines(selectedLines, { notify: false });
        if (render) viewer.render(true);
      },
    ));
    const unsubscribe = viewer.subscribeToScroll((scrollTop) => props.onScroll?.(scrollTop, viewer));
    props.ref(viewer);
    onCleanup(() => {
      unsubscribe();
      props.ref(undefined);
      viewer.cleanUp();
      for (const slot of slots.values()) slot.dispose();
      slots.clear();
    });
  });

  return <div ref={container} class={props.class} tabIndex={0} />;
}

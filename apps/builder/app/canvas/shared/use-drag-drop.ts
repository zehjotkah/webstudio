import { useLayoutEffect, useRef } from "react";
import { elementComponent, type Instance } from "@webstudio-is/sdk";
import {
  type Point,
  useAutoScroll,
  useDrag,
  useDrop,
  computeIndicatorPlacement,
} from "@webstudio-is/design-system";
import {
  $dragAndDropState,
  $instances,
  $props,
  $registeredComponentMetas,
  type ItemDropTarget,
} from "~/shared/nano-states";
import { publish, useSubscribe } from "~/shared/pubsub";
import {
  getComponentTemplateData,
  insertWebstudioElementAt,
  insertWebstudioFragmentAt,
  reparentInstance,
} from "~/shared/instance-utils";
import {
  getElementByInstanceSelector,
  getInstanceIdFromElement,
  getInstanceSelectorFromElement,
} from "~/shared/dom-utils";
import {
  type InstanceSelector,
  areInstanceSelectorsEqual,
} from "~/shared/tree-utils";
import { findClosestInstanceMatchingFragment } from "~/shared/matcher";
import {
  findClosestContainer,
  findClosestRichText,
  isTreeSatisfyingContentModel,
} from "~/shared/content-model";

declare module "~/shared/pubsub" {
  export interface PubsubMap {
    dragEnd: DragEndPayload;
    dragMove: DragMovePayload;
    dragStart: DragStartPayload;
    dropTargetChange: undefined | ItemDropTarget;
    cancelCurrentDrag: undefined;
  }
}

type Origin = "canvas" | "panel";

export type DragStartPayload =
  | { origin: Origin; type: "insert"; dragComponent: Instance["component"] }
  | {
      origin: Origin;
      type: "reparent";
      dragInstanceSelector: InstanceSelector;
    };

export type DragEndPayload = {
  isCanceled: boolean;
};

export type DragMovePayload = { canvasCoordinates: Point };

const findClosestDroppableInstanceSelector = (
  instanceSelector: InstanceSelector,
  dragPayload: DragStartPayload
) => {
  const instances = $instances.get();
  const props = $props.get();
  const metas = $registeredComponentMetas.get();

  // prevent dropping anything into non containers like image
  instanceSelector = findClosestContainer({
    metas,
    props,
    instances,
    instanceSelector,
  });
  let droppableIndex = -1;
  if (dragPayload?.type === "insert") {
    // allow dropping element into any container
    if (dragPayload.dragComponent === elementComponent) {
      droppableIndex = 0;
    } else {
      const fragment = getComponentTemplateData(dragPayload.dragComponent);
      if (fragment) {
        droppableIndex = findClosestInstanceMatchingFragment({
          instances,
          props,
          metas,
          instanceSelector,
          fragment,
        });
      }
    }
  }
  if (dragPayload?.type === "reparent") {
    const dropInstanceSelector = [
      dragPayload.dragInstanceSelector[0],
      ...instanceSelector,
    ];
    const matches = isTreeSatisfyingContentModel({
      instances,
      props,
      metas,
      instanceSelector: dropInstanceSelector,
    });
    droppableIndex = matches ? 0 : -1;
  }

  if (droppableIndex === -1) {
    return;
  }
  const droppableInstanceSelector = instanceSelector.slice(droppableIndex);
  return droppableInstanceSelector;
};

const initialState: {
  dropTarget: ItemDropTarget | undefined;
  dragPayload: DragStartPayload | undefined;
} = {
  dropTarget: undefined,
  dragPayload: undefined,
};

const sharedDropOptions = {
  getValidChildren: (parent: Element) => {
    return Array.from(parent.children).filter(
      (child) => getInstanceIdFromElement(child) !== undefined
    );
  },
};

export const useDragAndDrop = () => {
  const state = useRef({ ...initialState });

  const autoScrollHandlers = useAutoScroll({ fullscreen: true });

  const dropHandlers = useDrop<InstanceSelector>({
    ...sharedDropOptions,

    elementToData(element) {
      const instanceSelector = getInstanceSelectorFromElement(element);
      if (instanceSelector === undefined) {
        return false;
      }
      return instanceSelector;
    },

    // This must be fast, it can be called multiple times per pointer move
    swapDropTarget(dropTarget) {
      const { dragPayload } = state.current;

      if (dropTarget === undefined || dragPayload === undefined) {
        return;
      }

      const dropInstanceSelector = dropTarget.data;

      const newDropInstanceSelector = dropInstanceSelector.slice();
      if (dropTarget.area !== "center") {
        newDropInstanceSelector.shift();
      }

      // Don't allow to drop inside drag item or any of its children
      if (dragPayload.type === "reparent") {
        const [dragInstanceId] = dragPayload.dragInstanceSelector;
        const dragInstanceIndex =
          newDropInstanceSelector.indexOf(dragInstanceId);
        if (dragInstanceIndex !== -1) {
          newDropInstanceSelector.splice(0, dragInstanceIndex + 1);
        }
      }

      const droppableInstanceSelector = findClosestDroppableInstanceSelector(
        newDropInstanceSelector,
        dragPayload
      );
      if (droppableInstanceSelector === undefined) {
        return;
      }

      if (
        areInstanceSelectorsEqual(
          dropInstanceSelector,
          droppableInstanceSelector
        )
      ) {
        return dropTarget;
      }

      const element = getElementByInstanceSelector(droppableInstanceSelector);
      if (element === undefined) {
        return;
      }

      return { data: droppableInstanceSelector, element };
    },

    onDropTargetChange(dropTarget) {
      publish({
        type: "dropTargetChange",
        payload:
          dropTarget === undefined
            ? undefined
            : {
                placement: dropTarget.placement,
                indexWithinChildren: dropTarget.indexWithinChildren,
                itemSelector: dropTarget.data,
              },
      });
    },
  });

  const dragHandlers = useDrag<InstanceSelector>({
    elementToData(element) {
      const instanceSelector = getInstanceSelectorFromElement(element);
      if (instanceSelector === undefined) {
        return false;
      }
      // cannot drag while editing text
      if (element.closest("[contenteditable=true]")) {
        return false;
      }
      // When trying to drag an instance inside editor, drag the editor instead
      return (
        findClosestRichText({
          instanceSelector,
          instances: $instances.get(),
          props: $props.get(),
          metas: $registeredComponentMetas.get(),
        }) ?? instanceSelector
      );
    },

    onStart({ data: dragInstanceSelector }) {
      publish({
        type: "dragStart",
        payload: {
          type: "reparent",
          origin: "canvas",
          dragInstanceSelector,
        },
      });
    },
    onMove: (point) => {
      publish({
        type: "dragMove",
        payload: { canvasCoordinates: point },
      });
    },
    onEnd({ isCanceled }) {
      publish({
        type: "dragEnd",
        payload: { isCanceled },
      });
    },
  });

  // We have to use useLayoutEffect to setup the refs
  // because we want to use <body> as a root.
  // We prefer useLayoutEffect over useEffect
  // because it's closer in the life cycle to when React noramlly calls the "ref" callbacks.
  useLayoutEffect(() => {
    dropHandlers.rootRef(document.documentElement);
    dragHandlers.rootRef(document.documentElement);
    window.addEventListener("scroll", dropHandlers.handleScroll);

    return () => {
      dropHandlers.rootRef(null);
      dragHandlers.rootRef(null);
      window.removeEventListener("scroll", dropHandlers.handleScroll);
    };
  }, [dragHandlers, dropHandlers, autoScrollHandlers]);

  useSubscribe("cancelCurrentDrag", () => {
    dragHandlers.cancelCurrentDrag();
  });

  // Handle drag from the panel
  // ================================================================

  useSubscribe("dragStart", (dragPayload) => {
    state.current.dragPayload = dragPayload;
    autoScrollHandlers.setEnabled(true);
    dropHandlers.handleStart();
  });

  useSubscribe("dragMove", ({ canvasCoordinates }) => {
    dropHandlers.handleMove(canvasCoordinates);
    autoScrollHandlers.handleMove(canvasCoordinates);
  });

  useSubscribe("dropTargetChange", (dropTarget) => {
    state.current.dropTarget = dropTarget;
    if (dropTarget === undefined) {
      $dragAndDropState.set({
        ...$dragAndDropState.get(),
        placementIndicator: undefined,
      });
      return;
    }
    const element = getElementByInstanceSelector(dropTarget.itemSelector);
    if (element === undefined) {
      return;
    }
    $dragAndDropState.set({
      ...$dragAndDropState.get(),
      placementIndicator: computeIndicatorPlacement({
        ...sharedDropOptions,
        element,
        placement: dropTarget.placement,
      }),
    });
  });

  useSubscribe("dragEnd", ({ isCanceled }) => {
    dropHandlers.handleEnd({ isCanceled });
    autoScrollHandlers.setEnabled(false);
    const { dropTarget, dragPayload } = state.current;

    if (dropTarget && dragPayload && isCanceled === false) {
      const insertable = {
        parentSelector: dropTarget.itemSelector,
        position: dropTarget.indexWithinChildren,
      };
      if (dragPayload.type === "insert") {
        if (dragPayload.dragComponent === elementComponent) {
          insertWebstudioElementAt(insertable);
        } else {
          const fragment = getComponentTemplateData(dragPayload.dragComponent);
          if (fragment) {
            insertWebstudioFragmentAt(fragment, insertable);
          }
        }
      }
      if (dragPayload.type === "reparent") {
        reparentInstance(dragPayload.dragInstanceSelector, insertable);
      }
    }

    state.current = { ...initialState };
  });
};

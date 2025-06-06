import { current, isDraft } from "immer";
import { nanoid } from "nanoid";
import { toast } from "@webstudio-is/design-system";
import { equalMedia, type StyleValue } from "@webstudio-is/css-engine";
import {
  type Instances,
  type StyleSource,
  type Instance,
  type StyleSourceSelection,
  type StyleDecl,
  type Asset,
  type StyleSources,
  type Breakpoints,
  type DataSources,
  type DataSource,
  type Breakpoint,
  type WebstudioFragment,
  type WebstudioData,
  type Resource,
  type WsComponentMeta,
  getStyleDeclKey,
  findTreeInstanceIds,
  findTreeInstanceIdsExcludingSlotDescendants,
  decodeDataSourceVariable,
  encodeDataSourceVariable,
  transpileExpression,
  ROOT_INSTANCE_ID,
  portalComponent,
  collectionComponent,
  Prop,
  Props,
  elementComponent,
  tags,
} from "@webstudio-is/sdk";
import {
  $props,
  $styles,
  $styleSourceSelections,
  $styleSources,
  $instances,
  $registeredComponentMetas,
  $dataSources,
  $assets,
  $breakpoints,
  $pages,
  $resources,
  $registeredTemplates,
  $project,
} from "./nano-states";
import {
  type DroppableTarget,
  type InstanceSelector,
  findLocalStyleSourcesWithinInstances,
  getReparentDropTargetMutable,
  getInstanceOrCreateFragmentIfNecessary,
  wrapEditableChildrenAroundDropTargetMutable,
} from "./tree-utils";
import { removeByMutable } from "./array-utils";
import { serverSyncStore } from "./sync";
import { setDifference, setUnion } from "./shim";
import { breakCyclesMutable, findCycles } from "@webstudio-is/project-build";
import {
  $awareness,
  $selectedInstancePath,
  $selectedPage,
  getInstancePath,
  selectInstance,
  type InstancePath,
} from "./awareness";
import { findClosestInstanceMatchingFragment } from "./matcher";
import {
  findAvailableVariables,
  restoreExpressionVariables,
  unsetExpressionVariables,
} from "./data-variables";
import {
  findClosestNonTextualContainer,
  isRichTextTree,
  isTreeSatisfyingContentModel,
} from "./content-model";
import type { Project } from "@webstudio-is/project";
import { getInstanceLabel } from "~/builder/shared/instance-label";

/**
 * structuredClone can be invoked on draft and throw error
 * extract current snapshot before cloning
 */
export const unwrap = <Value>(value: Value) =>
  isDraft(value) ? current(value) : value;

export const updateWebstudioData = (mutate: (data: WebstudioData) => void) => {
  serverSyncStore.createTransaction(
    [
      $pages,
      $instances,
      $props,
      $breakpoints,
      $styleSourceSelections,
      $styleSources,
      $styles,
      $dataSources,
      $resources,
      $assets,
    ],
    (
      pages,
      instances,
      props,
      breakpoints,
      styleSourceSelections,
      styleSources,
      styles,
      dataSources,
      resources,
      assets
    ) => {
      // @todo normalize pages
      if (pages === undefined) {
        return;
      }
      mutate({
        pages,
        instances,
        props,
        dataSources,
        resources,
        breakpoints,
        styleSourceSelections,
        styleSources,
        styles,
        assets,
      });

      const cycles = findCycles(instances.values());

      // Detect and fix cycles in the instance tree, then report
      if (cycles.length > 0) {
        toast.info("Detected and fixed cycles in the instance tree.");

        breakCyclesMutable(
          instances.values(),
          (node) => node.component === "Slot"
        );
      }
    }
  );
};

export const getWebstudioData = (): WebstudioData => {
  const pages = $pages.get();
  if (pages === undefined) {
    throw Error(`Cannot get webstudio data with empty pages`);
  }
  return {
    pages,
    instances: $instances.get(),
    props: $props.get(),
    dataSources: $dataSources.get(),
    resources: $resources.get(),
    breakpoints: $breakpoints.get(),
    styleSourceSelections: $styleSourceSelections.get(),
    styleSources: $styleSources.get(),
    styles: $styles.get(),
    assets: $assets.get(),
  };
};

export const findAllEditableInstanceSelector = ({
  instanceSelector,
  instances,
  props,
  metas,
  results,
}: {
  instanceSelector: InstanceSelector;
  instances: Instances;
  props: Props;
  metas: Map<string, WsComponentMeta>;
  results: InstanceSelector[];
}) => {
  const [instanceId] = instanceSelector;

  if (instanceId === undefined) {
    return;
  }

  // Check if current instance is text editing instance
  if (isRichTextTree({ instanceId, instances, props, metas })) {
    results.push(instanceSelector);
    return;
  }

  const instance = instances.get(instanceId);
  if (instance) {
    for (const child of instance.children) {
      if (child.type === "id") {
        findAllEditableInstanceSelector({
          instanceSelector: [child.value, ...instanceSelector],
          instances,
          props,
          metas,
          results,
        });
      }
    }
  }
};

export const insertInstanceChildrenMutable = (
  data: Omit<WebstudioData, "pages">,
  children: Instance["children"],
  insertTarget: Insertable
) => {
  const dropTarget: DroppableTarget = {
    parentSelector: insertTarget.parentSelector,
    position: insertTarget.position === "after" ? "end" : insertTarget.position,
  };
  const metas = $registeredComponentMetas.get();
  insertTarget =
    getInstanceOrCreateFragmentIfNecessary(data.instances, dropTarget) ??
    insertTarget;
  insertTarget =
    wrapEditableChildrenAroundDropTargetMutable(
      data.instances,
      data.props,
      metas,
      dropTarget
    ) ?? insertTarget;
  const [parentInstanceId] = insertTarget.parentSelector;
  const parentInstance = data.instances.get(parentInstanceId);
  if (parentInstance === undefined) {
    return;
  }
  if (dropTarget.position === "end") {
    parentInstance.children.push(...children);
  } else {
    parentInstance.children.splice(dropTarget.position, 0, ...children);
  }
};

export const insertWebstudioElementAt = (insertable?: Insertable) => {
  const instances = $instances.get();
  const props = $props.get();
  const metas = $registeredComponentMetas.get();
  // find closest container and try to match new element with it
  if (insertable === undefined) {
    const instancePath = $selectedInstancePath.get();
    if (instancePath === undefined) {
      return false;
    }
    const [{ instanceSelector }] = instancePath;
    const containerSelector = findClosestNonTextualContainer({
      instances,
      props,
      metas,
      instanceSelector,
    });
    const insertableIndex = instanceSelector.length - containerSelector.length;
    if (insertableIndex === 0) {
      insertable = {
        parentSelector: containerSelector,
        position: "end",
      };
    } else {
      const containerInstance = instances.get(containerSelector[0]);
      if (containerInstance === undefined) {
        return false;
      }
      const lastChildInstanceId = instanceSelector[insertableIndex - 1];
      const lastChildPosition = containerInstance.children.findIndex(
        (child) => child.type === "id" && child.value === lastChildInstanceId
      );
      insertable = {
        parentSelector: containerSelector,
        position: lastChildPosition + 1,
      };
    }
  }
  // create element and find matching tag
  const element: Instance = {
    type: "instance",
    id: nanoid(),
    component: elementComponent,
    children: [],
  };
  const newInstances = new Map(instances);
  newInstances.set(element.id, element);
  let matchingTag: undefined | string;
  for (const tag of tags) {
    element.tag = tag;
    const isSatisfying = isTreeSatisfyingContentModel({
      instances: newInstances,
      props,
      metas,
      instanceSelector: [element.id, ...insertable.parentSelector],
    });
    if (isSatisfying) {
      matchingTag = tag;
      break;
    }
  }
  if (matchingTag === undefined) {
    return false;
  }
  // insert element
  updateWebstudioData((data) => {
    data.instances.set(element.id, element);
    const children: Instance["children"] = [{ type: "id", value: element.id }];
    insertInstanceChildrenMutable(data, children, insertable);
  });
  selectInstance([element.id, ...insertable.parentSelector]);
  return true;
};

export const insertWebstudioFragmentAt = (
  fragment: WebstudioFragment,
  insertable?: Insertable
): boolean => {
  // cannot insert empty fragment
  if (fragment.children.length === 0) {
    return false;
  }
  const project = $project.get();
  insertable = findClosestInsertable(fragment, insertable) ?? insertable;
  if (project === undefined || insertable === undefined) {
    return false;
  }
  let newInstanceSelector: undefined | InstanceSelector;
  updateWebstudioData((data) => {
    const instancePath = getInstancePath(
      insertable.parentSelector,
      data.instances
    );
    if (instancePath === undefined) {
      return;
    }
    const { newInstanceIds } = insertWebstudioFragmentCopy({
      data,
      fragment,
      availableVariables: findAvailableVariables({
        ...data,
        startingInstanceId: instancePath[0].instance.id,
      }),
      projectId: project.id,
    });
    const children: Instance["children"] = fragment.children.map((child) => {
      if (child.type === "id") {
        return {
          type: "id",
          value: newInstanceIds.get(child.value) ?? child.value,
        };
      }
      return child;
    });
    let parentSelector;
    let position: number | "end";
    if (insertable.position === "after") {
      if (instancePath.length === 1) {
        parentSelector = insertable.parentSelector;
        position = "end";
      } else {
        parentSelector = instancePath[1].instanceSelector;
        const [{ instance }, { instance: parentInstance }] = instancePath;
        const index = parentInstance.children.findIndex(
          (child) => child.type === "id" && child.value === instance.id
        );
        position = 1 + index;
      }
    } else {
      parentSelector = insertable.parentSelector;
      position = insertable.position;
    }
    insertInstanceChildrenMutable(data, children, {
      parentSelector,
      position,
    });
    newInstanceSelector = [children[0].value, ...parentSelector];
  });
  if (newInstanceSelector) {
    selectInstance(newInstanceSelector);
  }
  return true;
};

export const getComponentTemplateData = (
  componentOrTemplate: string
): WebstudioFragment => {
  const templates = $registeredTemplates.get();
  const templateMeta = templates.get(componentOrTemplate);
  if (templateMeta) {
    return templateMeta.template;
  }
  const newInstance: Instance = {
    id: nanoid(),
    type: "instance",
    component: componentOrTemplate,
    children: [],
  };
  return {
    children: [{ type: "id", value: newInstance.id }],
    instances: [newInstance],
    props: [],
    dataSources: [],
    styleSourceSelections: [],
    styleSources: [],
    styles: [],
    breakpoints: [],
    assets: [],
    resources: [],
  };
};

export const reparentInstanceMutable = (
  data: Omit<WebstudioData, "pages">,
  sourceInstanceSelector: InstanceSelector,
  dropTarget: DroppableTarget
) => {
  const project = $project.get();
  if (project === undefined) {
    return;
  }
  const [rootInstanceId] = sourceInstanceSelector;
  // delect is target is one of own descendants
  // prevent reparenting to avoid infinite loop
  const instanceDescendants = findTreeInstanceIds(
    data.instances,
    rootInstanceId
  );
  for (const instanceId of instanceDescendants) {
    if (dropTarget.parentSelector.includes(instanceId)) {
      return;
    }
  }
  // try to use slot fragment as target instead of slot itself
  const parentInstance = data.instances.get(dropTarget.parentSelector[0]);
  if (
    parentInstance?.component === portalComponent &&
    parentInstance.children.length > 0 &&
    parentInstance.children[0].type === "id"
  ) {
    const fragmentId = parentInstance.children[0].value;
    dropTarget = {
      parentSelector: [fragmentId, ...dropTarget.parentSelector],
      position: dropTarget.position,
    };
  }
  // move within same parent
  if (sourceInstanceSelector[1] === dropTarget.parentSelector[0]) {
    const [parentId] = dropTarget.parentSelector;
    const parent = data.instances.get(parentId);
    if (parent === undefined) {
      return;
    }
    const prevPosition = parent.children.findIndex(
      (child) => child.type === "id" && child.value === rootInstanceId
    );
    const child = parent.children[prevPosition];
    parent?.children.splice(prevPosition, 1);
    if (dropTarget.position === "end") {
      parent?.children.push(child);
    } else {
      // when parent is the same, we need to adjust the position
      // to account for the removal of the instance.
      let nextPosition = dropTarget.position;
      if (prevPosition < nextPosition) {
        nextPosition -= 1;
      }
      parent?.children.splice(nextPosition, 0, child);
    }
    return sourceInstanceSelector;
  }
  // move into another parent
  const fragment = extractWebstudioFragment(data, rootInstanceId);
  deleteInstanceMutable(
    data,
    getInstancePath(sourceInstanceSelector, data.instances)
  );
  // prepare drop target after deleting instance to recreate new slot fragment
  dropTarget =
    getReparentDropTargetMutable(
      data.instances,
      data.props,
      $registeredComponentMetas.get(),
      dropTarget
    ) ?? dropTarget;
  const { newInstanceIds } = insertWebstudioFragmentCopy({
    data,
    fragment,
    availableVariables: findAvailableVariables({
      ...data,
      startingInstanceId: dropTarget.parentSelector[0],
    }),
    projectId: project.id,
  });
  const [newParentId] = dropTarget.parentSelector;
  const newRootInstanceId =
    newInstanceIds.get(rootInstanceId) ?? rootInstanceId;
  const newParent = data.instances.get(newParentId);
  const newChild = { type: "id" as const, value: newRootInstanceId };
  if (dropTarget.position === "end") {
    newParent?.children.push(newChild);
  } else {
    newParent?.children.splice(dropTarget.position, 0, newChild);
  }
  return [newRootInstanceId, ...dropTarget.parentSelector];
};

export const reparentInstance = (
  sourceInstanceSelector: InstanceSelector,
  dropTarget: DroppableTarget
) => {
  updateWebstudioData((data) => {
    const newSelector = reparentInstanceMutable(
      data,
      sourceInstanceSelector,
      dropTarget
    );
    selectInstance(newSelector);
  });
};

export const deleteInstanceMutable = (
  data: Omit<WebstudioData, "pages">,
  instancePath: undefined | InstancePath
) => {
  if (instancePath === undefined) {
    return false;
  }
  const {
    instances,
    props,
    styleSourceSelections,
    styleSources,
    styles,
    dataSources,
    resources,
  } = data;
  let targetInstance = instancePath[0].instance;
  let parentInstance =
    instancePath.length > 1 ? instancePath[1]?.instance : undefined;
  const grandparentInstance =
    instancePath.length > 2 ? instancePath[2]?.instance : undefined;

  // delete parent fragment too if its last child is going to be deleted
  // use case for slots: slot became empty and remove display: contents
  // to be displayed properly on canvas
  if (
    parentInstance?.component === "Fragment" &&
    parentInstance.children.length === 1 &&
    grandparentInstance
  ) {
    targetInstance = parentInstance;
    parentInstance = grandparentInstance;
  }

  const instanceIds = findTreeInstanceIdsExcludingSlotDescendants(
    instances,
    targetInstance.id
  );
  const localStyleSourceIds = findLocalStyleSourcesWithinInstances(
    styleSources.values(),
    styleSourceSelections.values(),
    instanceIds
  );

  // mutate instances from data instead of instance path
  parentInstance = data.instances.get(parentInstance?.id as string);
  // may not exist when delete root
  if (parentInstance) {
    removeByMutable(
      parentInstance.children,
      (child) => child.type === "id" && child.value === targetInstance.id
    );
  }

  for (const instanceId of instanceIds) {
    instances.delete(instanceId);
  }
  // delete props, data sources and styles of deleted instance and its descendants
  for (const prop of props.values()) {
    if (instanceIds.has(prop.instanceId)) {
      props.delete(prop.id);
      if (prop.type === "resource") {
        resources.delete(prop.value);
      }
    }
  }
  for (const dataSource of dataSources.values()) {
    if (instanceIds.has(dataSource.scopeInstanceId ?? "")) {
      dataSources.delete(dataSource.id);
      if (dataSource.type === "resource") {
        resources.delete(dataSource.resourceId);
      }
    }
  }
  for (const instanceId of instanceIds) {
    styleSourceSelections.delete(instanceId);
  }
  for (const styleSourceId of localStyleSourceIds) {
    styleSources.delete(styleSourceId);
  }
  for (const [styleDeclKey, styleDecl] of styles) {
    if (localStyleSourceIds.has(styleDecl.styleSourceId)) {
      styles.delete(styleDeclKey);
    }
  }
  return true;
};

const traverseStyleValue = (
  value: StyleValue,
  callback: (value: StyleValue) => void
) => {
  if (
    value.type === "fontFamily" ||
    value.type === "image" ||
    value.type === "unit" ||
    value.type === "keyword" ||
    value.type === "unparsed" ||
    value.type === "invalid" ||
    value.type === "unset" ||
    value.type === "rgb" ||
    value.type === "function" ||
    value.type === "guaranteedInvalid"
  ) {
    callback(value);
    return;
  }
  if (value.type === "var") {
    if (value.fallback) {
      traverseStyleValue(value.fallback, callback);
    }
    return;
  }
  if (value.type === "tuple" || value.type === "layers") {
    for (const item of value.value) {
      traverseStyleValue(item, callback);
    }
    return;
  }
  if (value.type === "shadow") {
    traverseStyleValue(value.offsetX, callback);
    traverseStyleValue(value.offsetY, callback);
    if (value.blur) {
      traverseStyleValue(value.blur, callback);
    }
    if (value.spread) {
      traverseStyleValue(value.spread, callback);
    }
    if (value.color) {
      traverseStyleValue(value.color, callback);
    }
    return;
  }
  value satisfies never;
};

export const extractWebstudioFragment = (
  data: Omit<WebstudioData, "pages">,
  rootInstanceId: string,
  options: { unsetVariables?: Set<DataSource["id"]> } = {}
): WebstudioFragment => {
  const {
    assets,
    instances,
    dataSources,
    resources,
    props,
    styleSourceSelections,
    styleSources,
    breakpoints,
    styles,
  } = data;

  // collect the instance by id and all its descendants including portal instances
  const fragmentInstanceIds = findTreeInstanceIds(instances, rootInstanceId);
  let fragmentInstances: Instance[] = [];
  const fragmentStyleSourceSelections: StyleSourceSelection[] = [];
  const fragmentStyleSources: StyleSources = new Map();
  for (const instanceId of fragmentInstanceIds) {
    const instance = instances.get(instanceId);
    if (instance) {
      fragmentInstances.push(instance);
    }

    // collect all style sources bound to these instances
    const styleSourceSelection = styleSourceSelections.get(instanceId);
    if (styleSourceSelection) {
      fragmentStyleSourceSelections.push(styleSourceSelection);
      for (const styleSourceId of styleSourceSelection.values) {
        if (fragmentStyleSources.has(styleSourceId)) {
          continue;
        }
        const styleSource = styleSources.get(styleSourceId);
        if (styleSource === undefined) {
          continue;
        }
        fragmentStyleSources.set(styleSourceId, styleSource);
      }
    }
  }

  const fragmentAssetIds = new Set<Asset["id"]>();
  const fragmentFontFamilies = new Set<string>();

  // collect styles bound to these style sources
  const fragmentStyles: StyleDecl[] = [];
  const fragmentBreapoints: Breakpoints = new Map();
  for (const styleDecl of styles.values()) {
    if (fragmentStyleSources.has(styleDecl.styleSourceId) === false) {
      continue;
    }
    fragmentStyles.push(styleDecl);

    // collect breakpoints
    if (fragmentBreapoints.has(styleDecl.breakpointId) === false) {
      const breakpoint = breakpoints.get(styleDecl.breakpointId);
      if (breakpoint) {
        fragmentBreapoints.set(styleDecl.breakpointId, breakpoint);
      }
    }

    // collect assets including fonts
    traverseStyleValue(styleDecl.value, (value) => {
      if (value.type === "fontFamily") {
        for (const fontFamily of value.value) {
          fragmentFontFamilies.add(fontFamily);
        }
      }
      if (value.type === "image") {
        if (value.value.type === "asset") {
          fragmentAssetIds.add(value.value.value);
        }
      }
    });
  }

  // collect variables scoped to fragment instances
  // and variables outside of scope to unset
  const fragmentDataSources: DataSources = new Map();
  const fragmentResourceIds = new Set<Resource["id"]>();
  const unsetNameById = new Map<DataSource["id"], DataSource["name"]>();
  const unsetVariables = options.unsetVariables ?? new Set();
  for (const dataSource of dataSources.values()) {
    if (
      fragmentInstanceIds.has(dataSource.scopeInstanceId ?? "") &&
      unsetVariables.has(dataSource.id) === false
    ) {
      fragmentDataSources.set(dataSource.id, dataSource);
      if (dataSource.type === "resource") {
        fragmentResourceIds.add(dataSource.resourceId);
      }
    } else {
      unsetNameById.set(dataSource.id, dataSource.name);
    }
  }

  // unset variables outside of scope
  fragmentInstances = fragmentInstances.map((instance) => {
    instance = structuredClone(unwrap(instance));
    for (const child of instance.children) {
      if (child.type === "expression") {
        const expression = child.value;
        child.value = unsetExpressionVariables({ expression, unsetNameById });
      }
    }
    return instance;
  });

  // collect props bound to these instances
  // and unset variables outside of scope
  const fragmentProps: Prop[] = [];
  for (const prop of props.values()) {
    if (fragmentInstanceIds.has(prop.instanceId) === false) {
      continue;
    }

    if (prop.type === "expression") {
      const newProp = structuredClone(unwrap(prop));
      const expression = prop.value;
      newProp.value = unsetExpressionVariables({ expression, unsetNameById });
      fragmentProps.push(newProp);
      continue;
    }

    if (prop.type === "action") {
      const newProp = structuredClone(unwrap(prop));
      for (const value of newProp.value) {
        const expression = value.code;
        value.code = unsetExpressionVariables({ expression, unsetNameById });
      }
      fragmentProps.push(newProp);
      continue;
    }

    fragmentProps.push(prop);

    // collect assets
    if (prop.type === "asset") {
      fragmentAssetIds.add(prop.value);
    }

    // collect resources from props
    if (prop.type === "resource") {
      fragmentResourceIds.add(prop.value);
    }
  }

  // collect resources bound to all fragment data sources
  // and unset variables which are defined outside of scope
  // and used in resource
  const fragmentResources: Resource[] = [];
  for (const resourceId of fragmentResourceIds) {
    const resource = resources.get(resourceId);
    if (resource === undefined) {
      continue;
    }
    const newResource = structuredClone(unwrap(resource));
    newResource.url = unsetExpressionVariables({
      expression: newResource.url,
      unsetNameById,
    });
    for (const header of newResource.headers) {
      header.value = unsetExpressionVariables({
        expression: header.value,
        unsetNameById,
      });
    }
    if (newResource.body) {
      newResource.body = unsetExpressionVariables({
        expression: newResource.body,
        unsetNameById,
      });
    }
    fragmentResources.push(newResource);
  }

  const fragmentAssets: Asset[] = [];
  for (const asset of assets.values()) {
    if (
      fragmentAssetIds.has(asset.id) ||
      (asset.type === "font" && fragmentFontFamilies.has(asset.meta.family))
    ) {
      fragmentAssets.push(asset);
    }
  }

  return {
    children: [{ type: "id", value: rootInstanceId }],
    instances: fragmentInstances,
    styleSourceSelections: fragmentStyleSourceSelections,
    styleSources: Array.from(fragmentStyleSources.values()),
    breakpoints: Array.from(fragmentBreapoints.values()),
    styles: fragmentStyles,
    dataSources: Array.from(fragmentDataSources.values()),
    resources: fragmentResources,
    props: fragmentProps,
    assets: fragmentAssets,
  };
};

const replaceDataSources = (
  code: string,
  replacements: Map<DataSource["id"], DataSource["id"]>
) => {
  return transpileExpression({
    expression: code,
    replaceVariable: (identifier) => {
      const dataSourceId = decodeDataSourceVariable(identifier);
      if (dataSourceId === undefined) {
        return;
      }
      return encodeDataSourceVariable(
        replacements.get(dataSourceId) ?? dataSourceId
      );
    },
  });
};

export const insertWebstudioFragmentCopy = ({
  data,
  fragment,
  availableVariables,
  projectId,
}: {
  data: Omit<WebstudioData, "pages">;
  fragment: WebstudioFragment;
  availableVariables: DataSource[];
  projectId: Project["id"];
}) => {
  const newInstanceIds = new Map<Instance["id"], Instance["id"]>();
  const newDataSourceIds = new Map<DataSource["id"], DataSource["id"]>();
  const newDataIds = {
    newInstanceIds,
    newDataSourceIds,
  };

  const fragmentInstances: Instances = new Map();
  const portalContentRootIds = new Set<Instance["id"]>();
  for (const instance of fragment.instances) {
    fragmentInstances.set(instance.id, instance);
    if (instance.component === portalComponent) {
      for (const child of instance.children) {
        if (child.type === "id") {
          portalContentRootIds.add(child.value);
        }
      }
    }
  }

  const {
    assets,
    instances,
    resources,
    dataSources,
    props,
    breakpoints,
    styleSources,
    styles,
    styleSourceSelections,
  } = data;

  /**
   * insert reusables without changing their ids to not bloat data
   * and catch up with user changes
   * - assets
   * - breakpoints
   * - token styles
   * - portals
   *
   * breakpoints behave slightly differently and merged with existing ones
   * and those ids are used instead
   */

  // insert assets

  for (const asset of fragment.assets) {
    // asset can be already present if pasting to the same project
    if (assets.has(asset.id) === false) {
      // we use the same asset.id so the references are preserved
      assets.set(asset.id, { ...asset, projectId });
    }
  }

  // merge breakpoints

  const mergedBreakpointIds = new Map<Breakpoint["id"], Breakpoint["id"]>();
  for (const newBreakpoint of fragment.breakpoints) {
    let matched = false;
    for (const breakpoint of breakpoints.values()) {
      if (equalMedia(breakpoint, newBreakpoint)) {
        matched = true;
        mergedBreakpointIds.set(newBreakpoint.id, breakpoint.id);
        break;
      }
    }
    if (matched === false) {
      breakpoints.set(newBreakpoint.id, newBreakpoint);
    }
  }

  // insert tokens with their styles

  const tokenStyleSourceIds = new Set<StyleSource["id"]>();
  for (const styleSource of fragment.styleSources) {
    // prevent inserting styles when token is already present
    if (styleSource.type === "local" || styleSources.has(styleSource.id)) {
      continue;
    }
    styleSource.type satisfies "token";
    tokenStyleSourceIds.add(styleSource.id);
    styleSources.set(styleSource.id, styleSource);
  }
  for (const styleDecl of fragment.styles) {
    if (tokenStyleSourceIds.has(styleDecl.styleSourceId)) {
      const { breakpointId } = styleDecl;
      const newStyleDecl: StyleDecl = {
        ...styleDecl,
        breakpointId: mergedBreakpointIds.get(breakpointId) ?? breakpointId,
      };
      styles.set(getStyleDeclKey(newStyleDecl), newStyleDecl);
    }
  }

  let portalContentIds = new Set<Instance["id"]>();

  // insert portal contents
  // - instances
  // - data sources
  // - props
  // - local styles
  for (const rootInstanceId of portalContentRootIds) {
    const instanceIds = findTreeInstanceIdsExcludingSlotDescendants(
      fragmentInstances,
      rootInstanceId
    );
    portalContentIds = setUnion(portalContentIds, instanceIds);

    // prevent reinserting portals which could be already changed by user
    if (instances.has(rootInstanceId)) {
      continue;
    }

    const usedResourceIds = new Set<Resource["id"]>();
    for (const dataSource of fragment.dataSources) {
      // insert only data sources within portal content
      if (instanceIds.has(dataSource.scopeInstanceId ?? "")) {
        dataSources.set(dataSource.id, dataSource);
        if (dataSource.type === "resource") {
          usedResourceIds.add(dataSource.resourceId);
        }
      }
    }

    for (const prop of fragment.props) {
      if (instanceIds.has(prop.instanceId)) {
        props.set(prop.id, prop);
        if (prop.type === "resource") {
          usedResourceIds.add(prop.value);
        }
      }
    }

    for (const resource of fragment.resources) {
      if (usedResourceIds.has(resource.id)) {
        resources.set(resource.id, resource);
      }
    }

    for (const instance of fragment.instances) {
      if (instanceIds.has(instance.id)) {
        instances.set(instance.id, instance);
      }
    }

    // insert local style sources with their styles

    const instanceStyleSourceIds = new Set<StyleSource["id"]>();
    for (const styleSourceSelection of fragment.styleSourceSelections) {
      const { instanceId } = styleSourceSelection;
      if (instanceIds.has(instanceId) === false) {
        continue;
      }
      styleSourceSelections.set(instanceId, styleSourceSelection);
      for (const styleSourceId of styleSourceSelection.values) {
        instanceStyleSourceIds.add(styleSourceId);
      }
    }
    const localStyleSourceIds = new Set<StyleSource["id"]>();
    for (const styleSource of fragment.styleSources) {
      if (
        styleSource.type === "local" &&
        instanceStyleSourceIds.has(styleSource.id)
      ) {
        localStyleSourceIds.add(styleSource.id);
        styleSources.set(styleSource.id, styleSource);
      }
    }
    for (const styleDecl of fragment.styles) {
      if (localStyleSourceIds.has(styleDecl.styleSourceId)) {
        const { breakpointId } = styleDecl;
        const newStyleDecl: StyleDecl = {
          ...styleDecl,
          breakpointId: mergedBreakpointIds.get(breakpointId) ?? breakpointId,
        };
        styles.set(getStyleDeclKey(newStyleDecl), newStyleDecl);
      }
    }
  }

  /**
   * inserting unique content is structurally similar to inserting portal content
   * but all ids are regenerated to support duplicating existing content
   * - instances
   * - data sources
   * - props
   * - local styles
   */

  // generate new ids only instances outside of portals
  const fragmentInstanceIds = setDifference(
    new Set(fragmentInstances.keys()),
    portalContentIds
  );
  for (const instanceId of fragmentInstanceIds) {
    newInstanceIds.set(instanceId, nanoid());
  }
  fragmentInstanceIds.add(ROOT_INSTANCE_ID);
  newInstanceIds.set(ROOT_INSTANCE_ID, ROOT_INSTANCE_ID);

  const maskedIdByName = new Map<DataSource["name"], DataSource["id"]>();
  for (const dataSource of availableVariables) {
    maskedIdByName.set(dataSource.name, dataSource.id);
  }
  const newResourceIds = new Map<Resource["id"], Resource["id"]>();
  for (let dataSource of fragment.dataSources) {
    const scopeInstanceId = dataSource.scopeInstanceId ?? "";
    if (scopeInstanceId === ROOT_INSTANCE_ID) {
      // add global variable only if not exist already
      if (
        dataSources.has(dataSource.id) === false &&
        maskedIdByName.has(dataSource.name) === false
      ) {
        dataSources.set(dataSource.id, dataSource);
      }
      continue;
    }
    // insert only data sources within portal content
    if (fragmentInstanceIds.has(scopeInstanceId)) {
      const newDataSourceId = nanoid();
      newDataSourceIds.set(dataSource.id, newDataSourceId);
      dataSource = structuredClone(unwrap(dataSource));
      dataSource.id = newDataSourceId;
      dataSource.scopeInstanceId =
        newInstanceIds.get(scopeInstanceId) ?? scopeInstanceId;
      if (dataSource.type === "resource") {
        const newResourceId = nanoid();
        newResourceIds.set(dataSource.resourceId, newResourceId);
        dataSource.resourceId = newResourceId;
      }
      dataSources.set(dataSource.id, dataSource);
    }
  }

  for (let prop of fragment.props) {
    if (fragmentInstanceIds.has(prop.instanceId) === false) {
      continue;
    }
    prop = structuredClone(unwrap(prop));
    prop.id = nanoid();
    prop.instanceId = newInstanceIds.get(prop.instanceId) ?? prop.instanceId;
    if (prop.type === "expression") {
      prop.value = restoreExpressionVariables({
        expression: prop.value,
        maskedIdByName,
      });
      prop.value = replaceDataSources(prop.value, newDataSourceIds);
    }
    if (prop.type === "action") {
      for (const value of prop.value) {
        value.code = restoreExpressionVariables({
          expression: value.code,
          maskedIdByName,
        });
        value.code = replaceDataSources(value.code, newDataSourceIds);
      }
    }
    if (prop.type === "parameter") {
      prop.value = newDataSourceIds.get(prop.value) ?? prop.value;
    }
    if (prop.type === "resource") {
      const newResourceId = nanoid();
      newResourceIds.set(prop.value, newResourceId);
      prop.value = newResourceId;
    }
    props.set(prop.id, prop);
  }

  for (let resource of fragment.resources) {
    if (newResourceIds.has(resource.id) === false) {
      continue;
    }
    resource = structuredClone(unwrap(resource));
    resource.id = newResourceIds.get(resource.id) ?? resource.id;
    resource.url = restoreExpressionVariables({
      expression: resource.url,
      maskedIdByName,
    });
    resource.url = replaceDataSources(resource.url, newDataSourceIds);
    for (const header of resource.headers) {
      header.value = restoreExpressionVariables({
        expression: header.value,
        maskedIdByName,
      });
      header.value = replaceDataSources(header.value, newDataSourceIds);
    }
    if (resource.body) {
      resource.body = restoreExpressionVariables({
        expression: resource.body,
        maskedIdByName,
      });
      resource.body = replaceDataSources(resource.body, newDataSourceIds);
    }
    resources.set(resource.id, resource);
  }

  for (let instance of fragment.instances) {
    if (fragmentInstanceIds.has(instance.id)) {
      instance = structuredClone(unwrap(instance));
      instance.id = newInstanceIds.get(instance.id) ?? instance.id;
      for (const child of instance.children) {
        if (child.type === "id") {
          child.value = newInstanceIds.get(child.value) ?? child.value;
        }
        if (child.type === "expression") {
          child.value = restoreExpressionVariables({
            expression: child.value,
            maskedIdByName,
          });
          child.value = replaceDataSources(child.value, newDataSourceIds);
        }
      }
      instances.set(instance.id, instance);
    }
  }

  // insert local styles with new ids

  const newLocalStyleSources = new Map();
  for (const styleSource of fragment.styleSources) {
    if (styleSource.type === "local") {
      newLocalStyleSources.set(styleSource.id, styleSource);
    }
  }

  const newLocalStyleSourceIds = new Map<
    StyleSource["id"],
    StyleSource["id"]
  >();
  for (const { instanceId, values } of fragment.styleSourceSelections) {
    if (fragmentInstanceIds.has(instanceId) === false) {
      continue;
    }

    const existingStyleSourceIds =
      styleSourceSelections.get(instanceId)?.values ?? [];
    let existingLocalStyleSource;
    for (const styleSourceId of existingStyleSourceIds) {
      const styleSource = styleSources.get(styleSourceId);
      if (styleSource?.type === "local") {
        existingLocalStyleSource = styleSource;
      }
    }
    const newStyleSourceIds = [];
    for (let styleSourceId of values) {
      const newLocalStyleSource = newLocalStyleSources.get(styleSourceId);
      if (newLocalStyleSource) {
        // merge only :root styles and duplicate others
        if (instanceId === ROOT_INSTANCE_ID && existingLocalStyleSource) {
          // write local styles into existing local style source
          styleSourceId = existingLocalStyleSource.id;
        } else {
          // create new local styles
          const newId = nanoid();
          styleSources.set(newId, { ...newLocalStyleSource, id: newId });
          styleSourceId = newId;
        }
        newLocalStyleSourceIds.set(newLocalStyleSource.id, styleSourceId);
      }
      newStyleSourceIds.push(styleSourceId);
    }
    const newInstanceId = newInstanceIds.get(instanceId) ?? instanceId;
    styleSourceSelections.set(newInstanceId, {
      instanceId: newInstanceId,
      values: newStyleSourceIds,
    });
  }

  for (const styleDecl of fragment.styles) {
    const { breakpointId, styleSourceId } = styleDecl;
    if (newLocalStyleSourceIds.has(styleDecl.styleSourceId)) {
      const newStyleDecl: StyleDecl = {
        ...styleDecl,
        styleSourceId:
          newLocalStyleSourceIds.get(styleSourceId) ?? styleSourceId,
        breakpointId: mergedBreakpointIds.get(breakpointId) ?? breakpointId,
      };
      styles.set(getStyleDeclKey(newStyleDecl), newStyleDecl);
    }
  }

  return newDataIds;
};

export const findClosestSlot = (
  instances: Instances,
  instanceSelector: InstanceSelector
) => {
  for (const instanceId of instanceSelector) {
    const instance = instances.get(instanceId);
    if (instance?.component === "Slot") {
      return instance;
    }
  }
};

export type Insertable = {
  parentSelector: InstanceSelector;
  position: number | "end" | "after";
};

export const findClosestInsertable = (
  fragment: WebstudioFragment,
  from?: Insertable
): undefined | Insertable => {
  const selectedPage = $selectedPage.get();
  const awareness = $awareness.get();
  if (selectedPage === undefined) {
    return;
  }
  // paste to the page root if nothing is selected
  const instanceSelector = from?.parentSelector ??
    awareness?.instanceSelector ?? [selectedPage.rootInstanceId];
  if (instanceSelector[0] === ROOT_INSTANCE_ID) {
    toast.error(`Cannot insert into Global Root`);
    return;
  }
  const metas = $registeredComponentMetas.get();
  const instances = $instances.get();
  const props = $props.get();
  const containerSelector = findClosestNonTextualContainer({
    metas,
    props,
    instances,
    instanceSelector,
  });
  const closestContainerIndex =
    instanceSelector.length - containerSelector.length;
  if (closestContainerIndex === -1) {
    return;
  }
  let insertableIndex = findClosestInstanceMatchingFragment({
    metas,
    instances,
    props,
    instanceSelector: instanceSelector.slice(closestContainerIndex),
    fragment,
    onError: (message) => {
      const component = fragment.instances[0].component;
      const label = getInstanceLabel({ component }, {});
      toast.warn(message || `"${label}" has no place here`);
    },
  });
  if (insertableIndex === -1) {
    // fallback to closest container to always insert something
    // even when validation fails
    insertableIndex = 0;
  }

  // adjust with container lookup
  insertableIndex = insertableIndex + closestContainerIndex;
  const parentSelector = instanceSelector.slice(insertableIndex);
  if (insertableIndex === 0) {
    return from ?? { parentSelector, position: "end" };
  }
  const instance = instances.get(instanceSelector[insertableIndex]);
  if (instance === undefined) {
    return;
  }
  // skip collection item when inserting something and go straight into collection instance
  if (instance?.component === collectionComponent && insertableIndex === 1) {
    return {
      parentSelector,
      position: "end",
    };
  }
  const lastChildInstanceId = instanceSelector[insertableIndex - 1];
  const lastChildPosition = instance.children.findIndex(
    (child) => child.type === "id" && child.value === lastChildInstanceId
  );
  return {
    parentSelector,
    position: lastChildPosition + 1,
  };
};

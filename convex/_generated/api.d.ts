/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as business from "../business.js";
import type * as chat from "../chat.js";
import type * as chatQueue from "../chatQueue.js";
import type * as creations from "../creations.js";
import type * as findings from "../findings.js";
import type * as incidents from "../incidents.js";
import type * as jobs from "../jobs.js";
import type * as memory from "../memory.js";
import type * as missions from "../missions.js";
import type * as projectState from "../projectState.js";
import type * as push from "../push.js";
import type * as ui from "../ui.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  business: typeof business;
  chat: typeof chat;
  chatQueue: typeof chatQueue;
  creations: typeof creations;
  findings: typeof findings;
  incidents: typeof incidents;
  jobs: typeof jobs;
  memory: typeof memory;
  missions: typeof missions;
  projectState: typeof projectState;
  push: typeof push;
  ui: typeof ui;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};

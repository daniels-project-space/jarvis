/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as agents from "../agents.js";
import type * as approvals from "../approvals.js";
import type * as attention from "../attention.js";
import type * as brainContext from "../brainContext.js";
import type * as business from "../business.js";
import type * as chat from "../chat.js";
import type * as chatQueue from "../chatQueue.js";
import type * as commandCenter from "../commandCenter.js";
import type * as controlAuth from "../controlAuth.js";
import type * as creations from "../creations.js";
import type * as findings from "../findings.js";
import type * as incidents from "../incidents.js";
import type * as jobs from "../jobs.js";
import type * as memory from "../memory.js";
import type * as missions from "../missions.js";
import type * as projectIntelligence from "../projectIntelligence.js";
import type * as projectState from "../projectState.js";
import type * as push from "../push.js";
import type * as reminders from "../reminders.js";
import type * as ui from "../ui.js";
import type * as visualContext from "../visualContext.js";
import type * as watchPolicy from "../watchPolicy.js";
import type * as watchRules from "../watchRules.js";
import type * as watches from "../watches.js";
import type * as workEvents from "../workEvents.js";
import type * as workPolicy from "../workPolicy.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  agents: typeof agents;
  approvals: typeof approvals;
  attention: typeof attention;
  brainContext: typeof brainContext;
  business: typeof business;
  chat: typeof chat;
  chatQueue: typeof chatQueue;
  commandCenter: typeof commandCenter;
  controlAuth: typeof controlAuth;
  creations: typeof creations;
  findings: typeof findings;
  incidents: typeof incidents;
  jobs: typeof jobs;
  memory: typeof memory;
  missions: typeof missions;
  projectIntelligence: typeof projectIntelligence;
  projectState: typeof projectState;
  push: typeof push;
  reminders: typeof reminders;
  ui: typeof ui;
  visualContext: typeof visualContext;
  watchPolicy: typeof watchPolicy;
  watchRules: typeof watchRules;
  watches: typeof watches;
  workEvents: typeof workEvents;
  workPolicy: typeof workPolicy;
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

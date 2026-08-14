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
import type * as appleMapsOfflinePreflights from "../appleMapsOfflinePreflights.js";
import type * as approvals from "../approvals.js";
import type * as attention from "../attention.js";
import type * as brainContext from "../brainContext.js";
import type * as business from "../business.js";
import type * as chatQueue from "../chatQueue.js";
import type * as commandCenter from "../commandCenter.js";
import type * as controlAuth from "../controlAuth.js";
import type * as controlPlane from "../controlPlane.js";
import type * as controllerSession from "../controllerSession.js";
import type * as creationFiling from "../creationFiling.js";
import type * as creations from "../creations.js";
import type * as currentState from "../currentState.js";
import type * as fileHelpers from "../fileHelpers.js";
import type * as files from "../files.js";
import type * as findings from "../findings.js";
import type * as goalHandoffs from "../goalHandoffs.js";
import type * as goalIntegration from "../goalIntegration.js";
import type * as goalMode from "../goalMode.js";
import type * as googleAuth from "../googleAuth.js";
import type * as guestMigration from "../guestMigration.js";
import type * as incidents from "../incidents.js";
import type * as jobs from "../jobs.js";
import type * as memory from "../memory.js";
import type * as missionSupervisor from "../missionSupervisor.js";
import type * as missionSupervisorCommand from "../missionSupervisorCommand.js";
import type * as missionSupervisorHandoff from "../missionSupervisorHandoff.js";
import type * as missionSupervisorProtocol from "../missionSupervisorProtocol.js";
import type * as missionSupervisorWake from "../missionSupervisorWake.js";
import type * as missions from "../missions.js";
import type * as proactive from "../proactive.js";
import type * as proactivePolicy from "../proactivePolicy.js";
import type * as projectIntelligence from "../projectIntelligence.js";
import type * as projectState from "../projectState.js";
import type * as push from "../push.js";
import type * as reflexContext from "../reflexContext.js";
import type * as reminders from "../reminders.js";
import type * as sourceAdmission from "../sourceAdmission.js";
import type * as supervisorFleetManifest from "../supervisorFleetManifest.js";
import type * as supervisorJobControl from "../supervisorJobControl.js";
import type * as testSourceAdmission from "../testSourceAdmission.js";
import type * as travelDrafts from "../travelDrafts.js";
import type * as tripCanvas from "../tripCanvas.js";
import type * as ui from "../ui.js";
import type * as visualContext from "../visualContext.js";
import type * as voiceMetrics from "../voiceMetrics.js";
import type * as watchPolicy from "../watchPolicy.js";
import type * as watchRules from "../watchRules.js";
import type * as workEvents from "../workEvents.js";
import type * as workPolicy from "../workPolicy.js";
import type * as workReceiptAuthority from "../workReceiptAuthority.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  agents: typeof agents;
  appleMapsOfflinePreflights: typeof appleMapsOfflinePreflights;
  approvals: typeof approvals;
  attention: typeof attention;
  brainContext: typeof brainContext;
  business: typeof business;
  chatQueue: typeof chatQueue;
  commandCenter: typeof commandCenter;
  controlAuth: typeof controlAuth;
  controlPlane: typeof controlPlane;
  controllerSession: typeof controllerSession;
  creationFiling: typeof creationFiling;
  creations: typeof creations;
  currentState: typeof currentState;
  fileHelpers: typeof fileHelpers;
  files: typeof files;
  findings: typeof findings;
  goalHandoffs: typeof goalHandoffs;
  goalIntegration: typeof goalIntegration;
  goalMode: typeof goalMode;
  googleAuth: typeof googleAuth;
  guestMigration: typeof guestMigration;
  incidents: typeof incidents;
  jobs: typeof jobs;
  memory: typeof memory;
  missionSupervisor: typeof missionSupervisor;
  missionSupervisorCommand: typeof missionSupervisorCommand;
  missionSupervisorHandoff: typeof missionSupervisorHandoff;
  missionSupervisorProtocol: typeof missionSupervisorProtocol;
  missionSupervisorWake: typeof missionSupervisorWake;
  missions: typeof missions;
  proactive: typeof proactive;
  proactivePolicy: typeof proactivePolicy;
  projectIntelligence: typeof projectIntelligence;
  projectState: typeof projectState;
  push: typeof push;
  reflexContext: typeof reflexContext;
  reminders: typeof reminders;
  sourceAdmission: typeof sourceAdmission;
  supervisorFleetManifest: typeof supervisorFleetManifest;
  supervisorJobControl: typeof supervisorJobControl;
  testSourceAdmission: typeof testSourceAdmission;
  travelDrafts: typeof travelDrafts;
  tripCanvas: typeof tripCanvas;
  ui: typeof ui;
  visualContext: typeof visualContext;
  voiceMetrics: typeof voiceMetrics;
  watchPolicy: typeof watchPolicy;
  watchRules: typeof watchRules;
  workEvents: typeof workEvents;
  workPolicy: typeof workPolicy;
  workReceiptAuthority: typeof workReceiptAuthority;
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

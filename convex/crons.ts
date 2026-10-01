import { cronJobs, makeFunctionReference } from "convex/server";

const crons = cronJobs();
// A bounded dead-man check catches pre-rollout work and unforeseen callers.
// Ordinary idle time causes no Trigger run and no recurring minute timer.
crons.hourly("activity recovery safety", { minuteUTC: 43 }, makeFunctionReference<"mutation">("activityRecovery:tick"), {});
export default crons;

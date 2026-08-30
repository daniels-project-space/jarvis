// Shared by the owner control and its server route. Keeping the confirmation
// token outside of the route module leaves the route export surface compatible
// with Next's app-route validation.
export const BACKGROUND_READINESS_CONFIRMATION = "run_background_readiness";
export const BACKGROUND_WORKERS_RESUME_CONFIRMATION = "resume_verified_background_workers";

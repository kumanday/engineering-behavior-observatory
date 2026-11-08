import {listRuntimeRecipes} from "./runtime-catalog.js";
import {RuntimePolicyError, selectRuntimeRelease} from "./runtime-resolution.js";
import type {StudyRuntimeRequest} from "./study-runtimes.js";

const object = (value: unknown): value is Record<string, any> => Boolean(value && typeof value === "object" && !Array.isArray(value));
function keys(value: unknown, allowed: string[], label: string): asserts value is Record<string, any> {
  if (!object(value) || Object.keys(value).some((key) => !allowed.includes(key))) throw new RuntimePolicyError("RUNTIME_STUDY_INVALID", `${label} contains unknown fields or is not an object.`);
}
function target(value: unknown): asserts value is {platform: string; architecture: string} {
  keys(value, ["platform", "architecture"], "Runtime target");
  if (!["darwin", "linux", "win32"].includes(value.platform) || !["arm64", "x64"].includes(value.architecture)) throw new RuntimePolicyError("RUNTIME_PLATFORM_INVALID", "Runtime targets require platform darwin/linux/win32 and architecture arm64/x64.");
}
function policy(value: unknown): void {
  keys(value, ["minReleaseAgeMs", "allowPrerelease", "override"], "Runtime policy");
  // Exercise the same policy contract without consulting a registry.
  try {selectRuntimeRelease([], {...value, now: new Date().toISOString()});}
  catch (error) {if (!(error instanceof RuntimePolicyError) || error.code !== "RUNTIME_NO_ELIGIBLE_RELEASE") throw error;}
}
export function assertStudyRuntimeRequest(value: unknown): asserts value is StudyRuntimeRequest {
  keys(value, ["studyId", "roles", "openhandsBoundary", "policy", "harnessPolicies", "overrides", "roleTargets", "target"], "Runtime request");
  if (typeof value.studyId !== "string" || !value.studyId.trim() || !Array.isArray(value.roles) || !value.roles.length || value.roles.some((role: unknown) => typeof role !== "string") || new Set(value.roles).size !== value.roles.length) throw new RuntimePolicyError("RUNTIME_STUDY_INVALID", "A study ID and unique runtime roles are required.");
  const recipes = listRuntimeRecipes(), selected = recipes.filter((recipe) => value.roles.includes(recipe.id));
  if (selected.length !== value.roles.length) throw new RuntimePolicyError("RUNTIME_ROLE_UNKNOWN", "Request contains an unknown execution role.");
  if (value.openhandsBoundary !== undefined && !["host-vm", "task-guest"].includes(value.openhandsBoundary)) throw new RuntimePolicyError("RUNTIME_STUDY_INVALID", "OpenHands boundary must be host-vm or task-guest.");
  if (value.policy !== undefined) policy(value.policy);
  if (value.target !== undefined) target(value.target);
  if (value.roleTargets !== undefined) {
    keys(value.roleTargets, value.roles, "Role targets");
    Object.values(value.roleTargets).forEach(target);
  }
  if (value.harnessPolicies !== undefined) {
    keys(value.harnessPolicies, selected.map((recipe) => recipe.harness ?? recipe.id), "Harness policies");
    Object.values(value.harnessPolicies).forEach(policy);
  }
  if (value.overrides !== undefined) {
    keys(value.overrides, [...value.roles, ...selected.flatMap((recipe) => recipe.components.map((component) => component.id))], "Runtime overrides");
    for (const [id, version] of Object.entries(value.overrides)) {
      // PEP 440 is validated by release selection; mutable tags/ranges cannot be overrides.
      if (typeof version !== "string" || !/^\d+(?:\.\d+)+(?:[A-Za-z0-9.+_-]*)$/u.test(version)) throw new RuntimePolicyError("RUNTIME_POLICY_INVALID", `${id} needs an exact release version.`);
    }
  }
}

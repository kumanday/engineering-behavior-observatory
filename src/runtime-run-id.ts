import {createHash} from "node:crypto";

/** The queue assignment and frozen study jointly identify an executable run. */
export function studyRunId(studyFreezeDigest: string, sourceRunId: string): string {
  return `run-${createHash("sha256").update(JSON.stringify({sourceRunId, studyFreezeDigest})).digest("hex")}`;
}

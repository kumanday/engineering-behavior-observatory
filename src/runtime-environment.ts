import {delimiter, dirname} from "node:path";

/** env-node launchers must use the same coordinating Node as EBO. */
export function coordinatorRuntimeEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {...environment, PATH: [dirname(process.execPath), environment.PATH ?? process.env.PATH].filter(Boolean).join(delimiter)};
}

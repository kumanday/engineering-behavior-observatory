import type { RuntimeRegistryRequest } from "./runtime-registry.js";

export type RuntimeComponentRecipe = RuntimeRegistryRequest & { id: string; ecosystem?: string; purl?: string; executable?: string; sdk?: boolean };
export type RuntimeRecipe = { id: string; harness?: string; components: RuntimeComponentRecipe[]; revision: 1 };
const npm = (id: string, name: string, sdk = false, executable?: string): RuntimeComponentRecipe => ({ id, source: "npm", name, ecosystem: "npm", sdk, ...(executable ? { executable } : {}) });
/** Package membership and protocol surfaces are maintained; release numbers are discovered. */
export function listRuntimeRecipes(target: { platform: string; architecture: string } = { platform: process.platform, architecture: process.arch }): RuntimeRecipe[] {
  const devinPlatform = `${target.architecture === "arm64" ? "aarch64" : target.architecture === "x64" ? "x86_64" : target.architecture}-${target.platform === "darwin" ? "apple-darwin" : target.platform === "linux" ? "unknown-linux" : "pc-windows"}`;
  return [
    { id: "claude-agent-sdk", harness: "claude-agent-sdk", revision: 1, components: [npm("agent-sdk", "@anthropic-ai/claude-agent-sdk", true)] },
    { id: "codex-app-server", harness: "codex-app-server", revision: 1, components: [npm("codex", "@openai/codex", false, "codex")] },
    { id: "devin-cli", harness: "devin-cli", revision: 1, components: [{ id: "devin", source: "vendor", name: "devin-cli", repository: "CognitionAI/devin-cli", platform: devinPlatform, purl: "pkg:github/CognitionAI/devin-cli", executable: "bin/devin" }] },
    { id: "cursor-sdk", harness: "cursor-sdk", revision: 1, components: [npm("cursor-sdk", "@cursor/sdk", true)] },
    { id: "pi-sdk", harness: "pi-sdk", revision: 1, components: [npm("pi-sdk", "@earendil-works/pi-coding-agent", true), npm("pi-codemode", "@earendil-works/pi-codemode")] },
    { id: "factory-droid", harness: "factory-droid", revision: 1, components: [npm("droid-cli", "@factory/cli", false, "droid"), npm("droid-sdk", "@factory/droid-sdk", true)] },
    { id: "openhands-agent-server", harness: "openhands-agent-server", revision: 1, components: [{ id: "openhands", source: "oci", name: "ghcr.io/openhands/agent-server", repository: "OpenHands/software-agent-sdk", platform: "linux", architecture: target.architecture === "x64" ? "amd64" : target.architecture, flavor: "python", purl: "pkg:oci/agent-server?repository_url=ghcr.io/openhands/agent-server" }] },
    { id: "deepseek-harness", harness: "deepseek-harness", revision: 1, components: [npm("deepseek-runtime", "@deepseek-ai/dsh", false, "dsh"), npm("deepseek-client", "@deepseek-ai/dsh-sdk-client", true), npm("deepseek-protocol", "@deepseek-ai/dsh-sdk-protocol", true)] },
    { id: "codex-judge", revision: 1, components: [npm("codex-judge", "@openai/codex", false, "codex")] },
    { id: "harbor", revision: 1, components: [{ id: "harbor", source: "pypi", name: "harbor", repository: "harbor-framework/harbor", ecosystem: "PyPI" }] },
    { id: "smol", revision: 1, components: [{ id: "smol", source: "pypi", name: "smolmachines", repository: "smol-machines/smol", ecosystem: "PyPI" }] },
  ];
}

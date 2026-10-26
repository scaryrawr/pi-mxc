import { homedir } from "node:os";
import { isAbsolute, relative, sep } from "node:path";

import type {
  ExtensionAPI,
  ExtensionContext,
  ReadonlyFooterDataProvider,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

function formatTokens(count: number): string {
  if (count < 1000) return String(count);

  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;

  if (count < 1000000) return `${Math.round(count / 1000)}k`;

  return `${(count / 1000000).toFixed(1)}M`;
}

export function createFooter(
  ctx: Pick<ExtensionContext, "sessionManager" | "model" | "getContextUsage">,
  pi: Pick<ExtensionAPI, "getThinkingLevel" | "getSettings">,
  theme: Pick<Theme, "fg">,
  footerData: ReadonlyFooterDataProvider,
) {
  return {
    invalidate() {},
    render(width: number): string[] {
      const cwd = ctx.sessionManager.getCwd();
      const homeRelative = relative(homedir(), cwd);

      const insideHome =
        homeRelative !== ".." && !homeRelative.startsWith(`..${sep}`) && !isAbsolute(homeRelative);

      const path = insideHome ? (homeRelative ? `~${sep}${homeRelative}` : "~") : cwd;
      const branch = footerData.getGitBranch();
      const name = ctx.sessionManager.getSessionName();

      const statuses = [...footerData.getExtensionStatuses()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([, text]) => text.replace(/[\r\n\t]/g, " ").trim());

      const suffix = theme.fg("dim", statuses.length ? ` • ${statuses.join(" • ")}` : "");

      const location = theme.fg(
        "dim",
        `${path}${branch ? ` (${branch})` : ""}${name ? ` • ${name}` : ""}`,
      );

      const firstLine =
        truncateToWidth(location, Math.max(0, width - visibleWidth(suffix)), "…") + suffix;

      let input = 0;
      let output = 0;
      let cacheRead = 0;
      let cacheWrite = 0;
      let cost = 0;
      let cacheHitRate: number | undefined;

      for (const entry of ctx.sessionManager.getEntries()) {
        const usage =
          entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary"
            ? entry.usage
            : entry.type === "message" &&
                (entry.message.role === "assistant" || entry.message.role === "toolResult")
              ? entry.message.usage
              : undefined;

        if (!usage) continue;

        input += usage.input;
        output += usage.output;
        cacheRead += usage.cacheRead;
        cacheWrite += usage.cacheWrite;
        cost += usage.cost.total;

        if (entry.type === "message" && entry.message.role === "assistant") {
          const prompt = usage.input + usage.cacheRead + usage.cacheWrite;

          cacheHitRate = prompt > 0 ? (usage.cacheRead / prompt) * 100 : undefined;
        }
      }

      const stats: string[] = [];

      if (input) stats.push(`↑${formatTokens(input)}`);

      if (output) stats.push(`↓${formatTokens(output)}`);

      if (cacheRead) stats.push(`R${formatTokens(cacheRead)}`);

      if (cacheWrite) stats.push(`W${formatTokens(cacheWrite)}`);

      if ((cacheRead || cacheWrite) && cacheHitRate !== undefined)
        stats.push(`CH${cacheHitRate.toFixed(1)}%`);

      if (cost) stats.push(`$${cost.toFixed(3)}`);

      const context = ctx.getContextUsage();
      const percent = context?.percent;
      const window = context?.contextWindow ?? ctx.model?.contextWindow ?? 0;
      const auto = pi.getSettings().compaction?.enabled !== false ? " (auto)" : "";
      const contextText = `${percent == null ? "?" : `${percent.toFixed(1)}%`}/${formatTokens(window)}${auto}`;

      const color =
        percent != null && percent > 90
          ? "error"
          : percent != null && percent > 70
            ? "warning"
            : "dim";

      stats.push(theme.fg(color, contextText));

      const left = truncateToWidth(theme.fg("dim", stats.join(" ")), width, "…");
      const model = ctx.model;

      const provider =
        model && footerData.getAvailableProviderCount() > 1 ? `(${model.provider}) ` : "";

      const thinking = model?.reasoning
        ? ` • ${pi.getThinkingLevel() === "off" ? "thinking off" : pi.getThinkingLevel()}`
        : "";

      const right = truncateToWidth(
        theme.fg("dim", `${provider}${model?.id ?? "no-model"}${thinking}`),
        Math.max(0, width - visibleWidth(left) - 2),
        "",
      );

      const padding = " ".repeat(Math.max(0, width - visibleWidth(left) - visibleWidth(right)));

      return [truncateToWidth(firstLine, width, ""), left + padding + right];
    },
  };
}

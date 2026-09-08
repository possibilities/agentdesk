import packageJson from "../package.json" with { type: "json" };

export type Audience = "agent" | "operator" | "internal";
export type ArgumentType = "string" | "boolean" | "integer" | "number";

export interface ContractArgument {
  name: string;
  type: ArgumentType;
  description: string;
  required?: boolean;
  positional?: boolean;
  minimum?: number;
  role?: "call" | "output-format" | "store-selection" | "meta";
}

export interface ContractCommand {
  name: string;
  summary: string;
  audience: Audience;
  mutates: boolean;
  guidance?: string;
  blocking?: boolean;
  arguments: ContractArgument[];
}

export interface Contract {
  contract_version: 1;
  meta: {
    name: string;
    version: string;
    purpose: string;
    audience: "agent";
  };
  guidance: string;
  concepts: {
    model: Record<string, string>;
    output_contract: {
      envelope: Record<string, string>;
      exit_codes: Record<string, string>;
    };
    error_codes: { code: string; meaning: string; recovery?: string }[];
    read_only_commands: string[];
    agent_defaults: string[];
  };
  global_arguments: ContractArgument[];
  commands: ContractCommand[];
}

const PURPOSE =
  "Inspect and operate native macOS applications through Codex Computer Use, with one isolated session per MCP connection.";

const GUIDANCE = `Use Agentdesk for native macOS applications: inspect current app state, then run the smallest Computer Use JavaScript action and inspect again to verify the result. Use the browser skill for web pages.

The js command executes against one persistent Codex Computer Use session. Keep code focused on one observation or action so failures are attributable and uncertain GUI actions are never blindly retried. Agentdesk preserves native consent and approval requests; it never auto-accepts them. The session is reset only when js_reset is called or the MCP connection ends.`;

const COMMANDS: ContractCommand[] = [
  {
    name: "guide",
    summary: "Print Agentdesk's runbook or machine-readable contract",
    audience: "agent",
    mutates: false,
    guidance:
      "Call this when server instructions were not forwarded by an MCP aggregator. With --json it emits the fleet agent contract version 1.",
    arguments: [
      {
        name: "--json",
        type: "boolean",
        description: "Emit the contract in Agentdesk's JSON envelope",
      },
    ],
  },
  {
    name: "doctor",
    summary: "Check the Codex CLI and native Computer Use runtime",
    audience: "operator",
    mutates: false,
    guidance:
      "Use during installation and troubleshooting. This is an operator health check, not an agent workflow tool.",
    arguments: [],
  },
  {
    name: "mcp",
    summary: "Serve Agentdesk over MCP stdio",
    audience: "internal",
    mutates: true,
    blocking: true,
    guidance:
      "Runs until its host closes stdio or terminates the process; it owns and reaps its Codex child.",
    arguments: [],
  },
  {
    name: "js",
    summary: "Run JavaScript through Codex Computer Use",
    audience: "agent",
    mutates: true,
    guidance:
      "The code may inspect or operate the live desktop. Prefer one focused observation or action per call, and verify mutations with a later inspection.",
    arguments: [
      {
        name: "--code",
        type: "string",
        description: "JavaScript to execute in the persistent Computer Use session",
        required: true,
      },
      {
        name: "--timeout-ms",
        type: "integer",
        description: "Maximum execution time in milliseconds",
        minimum: 1,
      },
      {
        name: "--title",
        type: "string",
        description: "Short user-facing description of what the code does",
      },
    ],
  },
  {
    name: "js_reset",
    summary: "Reset the persistent Computer Use session",
    audience: "agent",
    mutates: true,
    guidance:
      "Use after the session becomes unusable or when a clean JavaScript environment is required. This discards session bindings but does not close applications.",
    arguments: [],
  },
];

const GLOBAL_ARGUMENTS: ContractArgument[] = [
  {
    name: "--help",
    type: "boolean",
    description: "Show help for this command",
    role: "meta",
  },
];

export function buildContract(): Contract {
  return {
    contract_version: 1,
    meta: {
      name: "agentdesk",
      version: packageJson.version,
      purpose: PURPOSE,
      audience: "agent",
    },
    guidance: GUIDANCE,
    concepts: {
      model: {
        session:
          "One persistent Codex Computer Use JavaScript environment owned by an MCP connection.",
        state:
          "The native application's current pixels and accessibility state, observed before and after actions.",
        approval:
          "A native consent or approval request that must be preserved for the human or MCP host; Agentdesk never auto-accepts it.",
      },
      output_contract: {
        envelope: {
          schema_version: "number",
          ok: "boolean",
          error: "{code,message,recovery?} | null",
          data: "payload | null",
        },
        exit_codes: {
          "0": "success",
          "1": "runtime or domain failure",
          "2": "usage fault raised before a command runs",
        },
      },
      error_codes: [
        {
          code: "computer_use_failed",
          meaning: "Codex Computer Use could not initialize or complete the requested operation.",
          recovery:
            "Run agentdesk doctor, satisfy any native consent request, then retry only if the failed call was observational or certainly had no effect.",
        },
      ],
      read_only_commands: COMMANDS.filter((command) => command.mutates === false).map(
        (command) => command.name,
      ),
      agent_defaults: [
        "Call guide when the host did not forward Agentdesk's server instructions.",
        "Use js to inspect the target application before acting.",
        "Perform the smallest useful action, then inspect again to verify it.",
        "Use js_reset only when the persistent Computer Use session must be discarded.",
      ],
    },
    global_arguments: GLOBAL_ARGUMENTS.map((argument) => ({ ...argument })),
    commands: COMMANDS.map((command) => ({
      ...command,
      arguments: command.arguments.map((argument) => ({ ...argument })),
    })),
  };
}

export const CONTRACT = buildContract();

export function guideEnvelope(contract: Contract = CONTRACT) {
  return {
    schema_version: 1 as const,
    ok: true as const,
    error: null,
    data: contract,
  };
}

const WIDTH = 88;

function wrap(text: string, indent = ""): string {
  const width = WIDTH - indent.length;
  return text
    .split("\n")
    .map((paragraph) => {
      if (paragraph === "") return "";
      const lines: string[] = [];
      let line = "";
      for (const word of paragraph.split(/\s+/)) {
        if (line === "") line = word;
        else if (`${line} ${word}`.length <= width) line = `${line} ${word}`;
        else {
          lines.push(`${indent}${line}`);
          line = word;
        }
      }
      if (line !== "") lines.push(`${indent}${line}`);
      return lines.join("\n");
    })
    .join("\n");
}

function argumentLabel(argument: ContractArgument): string {
  if (argument.type === "boolean") return argument.name;
  return `${argument.name} <${argument.name.replace(/^--/, "").toUpperCase()}>`;
}

function argumentDetails(argument: ContractArgument): string {
  const facts: string[] = [];
  if (argument.required === true) facts.push("Required.");
  if (argument.minimum !== undefined) facts.push(`Minimum ${argument.minimum}.`);
  return `${argument.description}.${facts.length === 0 ? "" : ` ${facts.join(" ")}`}`;
}

function renderArguments(arguments_: readonly ContractArgument[]): string {
  if (arguments_.length === 0) return "  (none)";
  return arguments_
    .map((argument) => `  ${argumentLabel(argument)}\n${wrap(argumentDetails(argument), "      ")}`)
    .join("\n");
}

export function renderTeaser(contract: Contract = CONTRACT): string {
  return `${contract.meta.purpose}\n`;
}

export function renderTopHelp(contract: Contract = CONTRACT): string {
  const width = Math.max(...contract.commands.map((command) => command.name.length)) + 2;
  const commands = contract.commands
    .map((command) => `  ${command.name.padEnd(width)}${command.summary}`)
    .join("\n");
  return `${contract.meta.name}: ${contract.meta.purpose}

Usage:
  ${contract.meta.name} <command> [options]

Commands:
${commands}

Options:
  --help          Show this help
  --agent-help    Show the agent runbook
  --agent-teaser  Show a one-line capability summary

Run \`${contract.meta.name} <command> --help\` for command options.
`;
}

export function renderCommandHelp(name: string, contract: Contract = CONTRACT): string {
  const command = contract.commands.find((candidate) => candidate.name === name);
  if (command === undefined) return renderTopHelp(contract);
  const guidance = command.guidance === undefined ? "" : `\n${wrap(command.guidance)}\n`;
  return `${contract.meta.name} ${command.name}: ${command.summary}
${guidance}
Usage:
  ${contract.meta.name} ${command.name} [options]

Options:
${renderArguments([...command.arguments, ...contract.global_arguments])}
`;
}

export function renderAgentHelp(contract: Contract = CONTRACT): string {
  const commands = contract.commands
    .map((command) => {
      const guidance = command.guidance === undefined ? "" : `\n${wrap(command.guidance, "    ")}`;
      const arguments_ =
        command.arguments.length === 0
          ? ""
          : `\n${command.arguments
              .map((argument) => `    ${argument.name} — ${argumentDetails(argument)}`)
              .join("\n")}`;
      return `- ${contract.meta.name} ${command.name} — ${command.summary}${guidance}${arguments_}`;
    })
    .join("\n\n");
  const defaults = contract.concepts.agent_defaults
    .map((step, index) => `${index + 1}. ${step}`)
    .join("\n");
  const errors = contract.concepts.error_codes
    .map((error) => {
      const recovery = error.recovery === undefined ? "" : ` Recovery: ${error.recovery}`;
      return `- ${error.code}: ${error.meaning}${recovery}`;
    })
    .join("\n");
  return `${contract.meta.name} ${contract.meta.version} — ${contract.meta.purpose}

${contract.guidance}

Workflow
${defaults}

Commands
${commands}

Output contract
- Successful machine output uses the fields: ${Object.keys(contract.concepts.output_contract.envelope).join(", ")}.
- Exit codes: ${Object.entries(contract.concepts.output_contract.exit_codes)
    .map(([code, meaning]) => `${code} (${meaning})`)
    .join(", ")}.
- Error codes:
${errors}

\`${contract.meta.name} guide --json\` emits this source contract in its JSON envelope.
`;
}

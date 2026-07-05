export type PrimitiveFlagType = "boolean" | "integer" | "number" | "string" | "string[]";

export type CommandArgSpec = {
  description: string;
  name: string;
  required?: boolean;
};

export type CommandFlagSpec = {
  aliases?: string[];
  default?: boolean | number | string;
  description: string;
  mcpName?: string;
  name: string;
  required?: boolean;
  type: PrimitiveFlagType;
};

export type CommandSpec<Handler> = {
  aliases?: string[][];
  args?: CommandArgSpec[];
  category: string;
  destructive?: boolean;
  description: string;
  flags?: CommandFlagSpec[];
  handler: Handler;
  mcpName: string;
  usage: string;
  words: string[];
};

export type McpInputSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties: false;
};

export type McpCommandContextInput = {
  flags: Record<string, string | boolean | string[]>;
  positionals: string[];
};

function isBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length === 0;
}

function schemaForString(description: string): Record<string, unknown> {
  return { description, type: "string" };
}

export function commandKey(words: string[]): string {
  return words.join(" ");
}

export function defaultMcpName(words: string[]): string {
  return words.map((word) => word.replaceAll("-", "_")).join("_");
}

export function flagToMcpName(flagName: string): string {
  return flagName.replaceAll("-", "_");
}

export function mcpNameToFlagName(propertyName: string): string {
  return propertyName.replaceAll("_", "-");
}

function flagMcpPropertyName(flag: CommandFlagSpec): string {
  return flag.mcpName ?? flagToMcpName(flag.name);
}

function hasExplicitWorkspaceFlag(spec: Pick<CommandSpec<unknown>, "flags">): boolean {
  return (spec.flags ?? []).some((flag) => flagMcpPropertyName(flag) === "workspace");
}

function jsonSchemaForFlagType(type: PrimitiveFlagType): Record<string, unknown> {
  switch (type) {
    case "boolean":
      return { type: "boolean" };
    case "integer":
      return { type: "integer" };
    case "number":
      return { type: "number" };
    case "string":
      return { type: "string" };
    case "string[]":
      return { type: "array", items: { type: "string" } };
  }
}

export function buildMcpInputSchema(
  spec: Pick<CommandSpec<unknown>, "args" | "flags">,
): McpInputSchema {
  const properties: Record<string, unknown> = {
    workspace: { description: "Optional workspace name", type: "string" },
  };
  const required: string[] = [];

  for (const arg of spec.args ?? []) {
    properties[arg.name] = schemaForString(arg.description);
    if (arg.required) {
      required.push(arg.name);
    }
  }

  for (const flag of spec.flags ?? []) {
    const propertyName = flagMcpPropertyName(flag);
    properties[propertyName] = {
      description: flag.description,
      ...jsonSchemaForFlagType(flag.type),
    };
    if (flag.required) {
      required.push(propertyName);
    }
  }

  return {
    additionalProperties: false,
    ...(required.length > 0 ? { required } : {}),
    properties,
    type: "object",
  };
}

function pushFlagValue(
  argv: string[],
  flagName: string,
  value: unknown,
  type: PrimitiveFlagType,
): void {
  if (value === undefined || value === null) {
    return;
  }

  if (type === "boolean") {
    if (value === true) {
      argv.push(`--${flagName}`);
    }
    return;
  }

  if (type === "string[]") {
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      if (item === undefined || item === null) {
        continue;
      }
      if (isBlankString(item)) {
        continue;
      }
      argv.push(`--${flagName}`, String(item));
    }
    return;
  }

  if (type === "string" && isBlankString(value)) {
    return;
  }

  argv.push(`--${flagName}`, String(value));
}

export function mcpInputToArgv(
  spec: Pick<CommandSpec<unknown>, "args" | "flags" | "words">,
  input: Record<string, unknown>,
): string[] {
  const argv = [...spec.words];

  if (
    !hasExplicitWorkspaceFlag(spec) &&
    input.workspace !== undefined &&
    input.workspace !== null &&
    !isBlankString(input.workspace)
  ) {
    argv.push("--workspace", String(input.workspace));
  }

  for (const arg of spec.args ?? []) {
    const value = input[arg.name];
    if (
      value !== undefined &&
      value !== null &&
      !(typeof value === "string" && value.trim().length === 0)
    ) {
      argv.push(String(value));
    }
  }

  for (const flag of spec.flags ?? []) {
    const propertyName = flagMcpPropertyName(flag);
    pushFlagValue(argv, flag.name, input[propertyName], flag.type);
  }

  argv.push("--json");
  return argv;
}

export function mcpInputToContextInput(
  spec: Pick<CommandSpec<unknown>, "args" | "flags">,
  input: Record<string, unknown>,
): McpCommandContextInput {
  const flags: Record<string, string | boolean | string[]> = {};
  const positionals: string[] = [];

  if (
    !hasExplicitWorkspaceFlag(spec) &&
    input.workspace !== undefined &&
    input.workspace !== null &&
    !isBlankString(input.workspace)
  ) {
    flags.workspace = String(input.workspace);
  }

  for (const arg of spec.args ?? []) {
    const value = input[arg.name];
    if (
      value !== undefined &&
      value !== null &&
      !(typeof value === "string" && value.trim().length === 0)
    ) {
      positionals.push(String(value));
    }
  }

  for (const flag of spec.flags ?? []) {
    const propertyName = flagMcpPropertyName(flag);
    const value = input[propertyName];
    if (value === undefined || value === null) {
      continue;
    }

    if (flag.type === "boolean") {
      if (value === true) {
        flags[flag.name] = true;
      }
      continue;
    }

    if (flag.type === "string[]") {
      const values = (Array.isArray(value) ? value : [value])
        .filter((item) => item !== undefined && item !== null && !isBlankString(item))
        .map((item) => String(item));
      if (values.length === 1) {
        flags[flag.name] = values[0] ?? "";
      } else if (values.length > 1) {
        flags[flag.name] = values;
      }
      continue;
    }

    if (flag.type === "string" && isBlankString(value)) {
      continue;
    }

    flags[flag.name] = String(value);
  }

  flags.json = true;
  return { flags, positionals };
}
